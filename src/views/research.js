// /research — the research workbench: a modular suite for setting up and
// reading research, arranged by the same layout engine the metrics page uses
// (src/metrics-layout.js, storage mc.research.layout) with one layer the
// engine does not have: modules can be switched on and off (Modules button,
// src/research-modules.js, storage mc.research.modules).
//
// THIS PAGE HAS NO CHAT SURFACE. Research workers run as tree nodes on the
// computers page; this page holds specs and results. That is the owner's
// amendment, and tools/test/research-workbench.test.mjs pins it.
//
// The page consumes only the browser-safe research projection.
// Authorization-gated rows are deliberately rendered through a separate
// metadata-only branch: title and authorizationReason are the only payload
// fields that branch reads.

import { el } from '../components.js'
import { fetchResearch } from '../live-status.js'
/* The one door every empty screen in this product offers, imported rather than
   written again here — see src/first-run-needs.js. */
import { GUIDE_ACTION } from '../first-run-needs.js'
import { createMetricsLayout } from '../metrics-layout.js'
import { createResearchRegistry } from '../research-modules.js'
import { createResearchWorkflow, RESEARCH_AREAS } from '../research-workflow.js'
/* Single-line on purpose: research-queue-degradation.test.mjs re-evaluates
   this module with every `^import` LINE stripped, so a wrapped import would
   leave its tail behind as garbage. */
import { RESEARCH_QUEUE_ROW_KEY, advanceItem, buildOwnItem, mergeQueueForRender, nextStatus, parseQueueRow, removeOwnItem } from '../research-queue-store.js'
import { RESEARCH_EXPERIMENTS_EVENT, RESEARCH_EXPERIMENTS_ROW_KEY, buildExperiment, commitExperimentChange, experimentsReadCheckpoint, cellsAwaitingService, cellsWithServiceStatus, decideDispatch, dispatchExperiment, experimentsSnapshot, parseExperimentsRow, removeExperiment, seedExperiments, submitExperimentRuns, parseResearchAgentSetup, parseExperimentImport, serializeExperimentImport } from '../research-experiments.js'
import { localTiersStatus, postBridgeAction } from '../mission-bridge.js'
import { TIER_CHOICES, DEFAULT_TIER } from '../fleet-tree-copy.js'
import { startAgentForNode } from './computers.js'
import { DATA_SOURCE_EVENT, resolveDataSource, sourceIsBadged } from '../data-source.js'
/* THE × ON A QUEUE ITEM, IN TWO HONEST FORMS. Your own note is really yours
   (one account row, research-queue-store.js) and the × deletes it from that
   row after a second press. A shipped item is the catalog's, not yours --
   removeOwnItem refuses it with "shipped items stay in the catalog" -- so the
   × on one hides it on this screen only, through the same per-list hidden set
   the ledger page uses, and the sentence under the first press says which of
   the two the second press will do. */
import { createHiddenRows } from '../hidden-rows.js'
import { armOnce } from '../arm-press.js'
import { PROJECT_ALL, PROJECT_UNFILED, filesUnder, readProjectSelection, readResearchSnapshot, saveProject, writeProjectSelection } from '../research-projects.js'
import { createAssignmentStore } from '../research-assignments.js'
/* THE SAME VALUE views/tools.js ALREADY SETTLED. shell/product-account.cjs
   putSetting() answers six distinct named refusals -- not signed in, a bad
   key, a value too long, a damaged partition, a full settings store, a
   refused disk write -- each with a reason written for a person. Reusing the
   shared sentence here rather than inventing a second "Sign in, then try it
   again." means a full store or a damaged partition is not blamed on being
   signed out in THIS file either; see the fuller comment beside its
   definition. */
import { saveRefusalSentence } from '../agent-tools-markup.js'
import { axisRowsToObject, columnRowsToSchema, gridRunPreview, parseAxes, parseResultSchema, parseDesignerRunner, parseRunner, runnerDesignerFields } from '../research-grid.js'
import { chartableColumn, chartableColumns, experimentExport, readResults, readRun, readRuns, resultReadVersion, resultTableModel, resultsExport, runDrillModel, runIsTerminal, runTaskDisplayStatus, runTaskIsStalled, runTaskStateWord } from '../research-runs.js'
import { findingDetailsModel, findingStateWord, readFindings, saveFinding } from '../research-findings.js'
import { createResultChart } from '../research-result-charts.js'
import { readLiveSession } from '../agent-session-registry.js'
import { createResearchProjectActivity } from '../research-project-activity.js'
import { RESEARCH_MASTER_ID } from '../research-settings.js'
import { createBenchmarkBuilder } from '../research-benchmark.js'
import { createResearchDataWorkspace } from '../research-data-workspace.js'
import { exportedBenchmarkExperiment } from '../research-benchmark-dispatch.js'
import '../research.css'
import '../research-finding-details.css'

/* WHERE THE SWITCH IS, derived from the section that draws it rather than
   spelled out here. The settings page opens the section a named row lives in
   and scrolls to that row, so this link lands on the control itself instead of
   on a page of two hundred others. The id comes from the section's own list, so
   a rename cannot leave this link pointing at nothing.

   IT IS A FUNCTION, AND THAT IS NOT A STYLE CHOICE.
   tools/test/research-queue-degradation.test.mjs re-evaluates this module with
   every `^import` LINE stripped, to prove the page still says something honest
   when a source it depends on is missing. A module-scope constant that reads an
   imported binding throws while that file is being evaluated, so the whole page
   becomes a blank screen instead of a degraded one -- which is the exact defect
   that test exists to catch. Read inside the function, the reference is only
   made when the page is genuinely rendering. */
function pipelineSettingHref() {
  /* THE MASTER SWITCH BY NAME, NOT BY POSITION. This read
     `RESEARCH_SETTING_IDS[0]` until 2026-08-20, which was the master only while
     that list held research rows and nothing else. It now also holds the agent
     tool-note row, so index 0 became a coincidence the order happens to
     preserve -- and a reordering would have sent a person following "the
     research pipeline is switched off in settings" to a different switch
     entirely, with every test still green. */
  return `#/settings?setting=${encodeURIComponent(RESEARCH_MASTER_ID)}`
}

/* Kept as a small DOM seam so the close rule can be exercised without
   booting the research service: only focus that the form itself held is
   returned. A successful create and Cancel both use this same path. */
export function restoreProjectFormFocus(form, opener) {
  if (form?.contains(document.activeElement)) opener?.focus()
}

const RESEARCH_QUEUE_URL = '/data/research-queue.json'
const RESEARCH_QUEUE_STATUSES = new Set(['queued', 'in-progress', 'complete'])

const esc = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  year: 'numeric', month: 'short', day: '2-digit',
})

function formatDate(value) {
  const at = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(at) ? dateFormatter.format(at) : 'unavailable'
}

function formatBytes(value) {
  if (!Number.isSafeInteger(value) || value < 0) return 'unavailable'
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`
  return `${(value / 1024 ** 2).toFixed(value < 10 * 1024 ** 2 ? 1 : 0)} MB`
}

function lockedReportMarkup(report) {
  // R198 boundary: do not add a fallback that reads summary/path/bytes/date.
  // A future malformed producer cannot make this branch disclose them.
  const title = report?.title || 'Locked report'
  const reason = report?.authorizationReason || 'This report stays locked until you authorize it.'
  return `
    <li class="research-report is-locked" data-locked-report="true">
      <span class="research-lock" aria-hidden="true">
        <svg viewBox="0 0 20 20"><rect x="4.5" y="8.5" width="11" height="8"/><path d="M7 8.5V6.2a3 3 0 0 1 6 0v2.3"/></svg>
      </span>
      <div class="research-report-body">
        <h3>${esc(title)}</h3>
        <p class="research-authorization">${esc(reason)}</p>
      </div>
    </li>`
}

function safeReportMarkup(report) {
  const date = formatDate(report?.dateObserved)
  const bytes = formatBytes(report?.bytes)
  return `
    <li class="research-report" data-safe-report="true">
      <div class="research-report-body">
        <div class="research-report-head">
          <h3>${esc(report?.title || 'Untitled report')}</h3>
          <dl class="research-report-meta">
            <div><dt>observed</dt><dd><time${date === 'unavailable' ? '' : ` datetime="${esc(report.dateObserved)}"`}>${esc(date)}</time></dd></div>
            <div><dt>size</dt><dd>${esc(bytes)}</dd></div>
          </dl>
        </div>
        <div class="research-context">
          <p>${esc(report?.summary || 'No summary was written for this report.')}</p>
        </div>
      </div>
    </li>`
}

function unavailableMarkup(label, reason) {
  return `<p class="research-unavailable projection-unavailable">${esc(label)} could not be read · ${esc(reason || 'the app was not told why')}</p>`
}

function emptyMarkup(label) {
  return `<p class="research-observed-empty">The research data has no ${esc(label)} in it yet.</p>`
}

function validQueueText(value, maxLength) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength
}

function validQueueItem(item) {
  return invalidQueueItemReason(item) === null
}

function invalidQueueItemReason(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return 'queue item must be an object'
  if (!validQueueText(item.id, 120)) return 'missing or invalid id'
  if (!validQueueText(item.title, 240)) return 'missing or invalid title'
  if (!RESEARCH_QUEUE_STATUSES.has(item.status)) return 'unknown status'
  if (!validQueueText(item.provenance, 80)) return 'missing or invalid provenance'
  if (!validQueueText(item.observation, 2000)) return 'missing or invalid observation'
  if (!validQueueText(item.researchQuestion, 1000)) return 'missing or invalid research question'
  return null
}

function queueItemRejection(item, index, seenIds) {
  const id = validQueueText(item?.id, 120) ? item.id : undefined
  const rejected = reason => id === undefined ? { index, reason } : { index, id, reason }
  if (!validQueueItem(item)) return rejected(invalidQueueItemReason(item))
  if (seenIds.has(id)) return rejected('duplicate id')

  seenIds.add(id)
  return null
}

async function fetchResearchQueue({ fetchImpl = fetch } = {}) {
  let response
  try {
    response = await fetchImpl(RESEARCH_QUEUE_URL, { cache: 'no-store' })
  } catch (error) {
    return { ok: false, reason: `network error reaching ${RESEARCH_QUEUE_URL}: ${error?.message || error}` }
  }
  if (!response?.ok) {
    return { ok: false, reason: `${RESEARCH_QUEUE_URL} responded ${response?.status ?? 'without a response'} ${response?.statusText || ''}`.trim() }
  }

  let payload
  try {
    payload = await response.json()
  } catch (error) {
    return { ok: false, reason: `${RESEARCH_QUEUE_URL} did not parse as JSON: ${error?.message || error}` }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || payload.schemaVersion !== 1 || !Array.isArray(payload.items)) {
    return { ok: false, reason: `${RESEARCH_QUEUE_URL} has an unrecognized shape` }
  }
  if (payload.items.length > 1000) {
    return { ok: false, reason: `${RESEARCH_QUEUE_URL} contains more than 1000 queue items` }
  }

  const items = []
  const rejected = []
  const seenIds = new Set()
  payload.items.forEach((item, index) => {
    const rejection = queueItemRejection(item, index, seenIds)
    if (rejection) rejected.push(rejection)
    else items.push(item)
  })
  return { ok: true, items, rejected }
}

/* `headControls` rides in the title row (the × at the card's right edge);
   `controls` stays under the text. The read-only render passes neither. */
function queueItemMarkup(item, controls = '', headControls = '') {
  const status = item.status === 'in-progress' ? 'in progress' : item.status
  const provenance = item.provenance.replace(/-/g, ' ')
  return `
    <li class="research-report" data-research-queue-item="${esc(item.id)}">
      <div class="research-report-body">
        <div class="research-report-head">
          <h3>${esc(item.title)}</h3>
          <dl class="research-report-meta">
            <div><dt>state</dt><dd>${esc(status)}</dd></div>
            <div><dt>origin</dt><dd>${esc(provenance)}</dd></div>
          </dl>${headControls}
        </div>
        <div class="research-context">
          <p>${esc(item.observation)}</p>
        </div>
        <p class="research-authorization"><strong>Research:</strong> ${esc(item.researchQuestion)}</p>${controls}
      </div>
    </li>`
}

function researchQueueMarkup(result) {
  if (!result?.ok) return unavailableMarkup('Research queue', result?.reason)
  const items = Array.isArray(result.items) ? result.items : []
  const rejected = Array.isArray(result.rejected) ? result.rejected : []
  if (items.length === 0 && rejected.length === 0) {
    return '<p class="research-observed-empty">No research items are queued.</p>'
  }

  const rejectionNotice = rejected.length === 0 ? '' : `
    <aside class="research-unavailable research-queue-rejections" data-research-queue-rejections role="status">
      <p><strong>${esc(items.length === 0
        ? `All ${rejected.length} research queue ${rejected.length === 1 ? 'item was' : 'items were'} rejected.`
        : `${rejected.length} research queue ${rejected.length === 1 ? 'item was' : 'items were'} rejected.`)}</strong></p>
      <ol>${rejected.map(item => `
        <li>Source index ${esc(item?.index)}${typeof item?.id === 'string' ? ` · id ${esc(item.id)}` : ''}: ${esc(item?.reason || 'invalid queue item')}</li>`).join('')}
      </ol>
    </aside>`
  const queueList = items.length === 0
    ? ''
    : `<ol class="research-catalog" data-research-queue-list>${items.map(item => queueItemMarkup(item)).join('')}</ol>`
  return `${rejectionNotice}${queueList}`
}

function findingMarkup(item) {
  return `<li><span>${esc(item?.status || 'unclassified')}</span><p>${esc(item?.claim || 'Finding text unavailable.')}</p></li>`
}

function taxonomyMarkup(item) {
  const count = Number.isSafeInteger(item?.count) ? String(item.count) : '—'
  return `<li><span>${esc(count)}</span><p>${esc(item?.label || 'Failure category unavailable.')}</p></li>`
}

function questionMarkup(item) {
  return `<li><p>${esc(item?.question || 'Question unavailable.')}</p><small>${esc(item?.methodToClose || 'No way to answer it was recorded.')}</small></li>`
}

function observationMarkup(observation, { label, emptyLabel, itemMarkup }) {
  if (!observation?.ok) return unavailableMarkup(label, observation?.reason)
  if (!Array.isArray(observation.value) || observation.value.length === 0) return emptyMarkup(emptyLabel)
  return `<ol class="research-register-list">${observation.value.map(itemMarkup).join('')}</ol>`
}

/* ---------- the sample face ----------
   Rendered when the one source axis (src/data-source.js) answers 'mock': a
   signed-out visitor on the website, or the example toggle on any host. It is
   NOT a second render — the owner's ruling is "all simulated pages ARE the UI
   pages, just mock data" — so every constant below feeds the same renderers
   the live loaders feed. Every value is invented for the demonstration and
   the mast says so: no file on this computer is read for it, and nothing a
   person does against it is ever written anywhere. */

const SAMPLE_QUEUE = Object.freeze({
  ok: true,
  rejected: [],
  items: [
    {
      id: 'sample-tokenizer-drift',
      title: 'Tokenizer drift between checkpoints',
      status: 'in-progress',
      provenance: 'owner-observation',
      observation: 'Two checkpoints of the same model disagree on 3% of tokenizations in the eval set.',
      researchQuestion: 'Does the drift move benchmark scores, or only token counts?',
    },
    {
      id: 'sample-judge-agreement',
      title: 'Judge model agreement on borderline answers',
      status: 'queued',
      provenance: 'run-report',
      observation: 'Two judge models agreed on 91% of clear answers but only 64% of borderline ones.',
      researchQuestion: 'Which judge disagreements predict a human overturn?',
    },
  ],
})

const SAMPLE_PROJECTION = Object.freeze({
  generatedAt: '2026-08-01T12:00:00.000Z',
  corpusCatalog: {
    ok: true,
    value: [
      {
        title: 'Example benchmark sweep — 3 models, 200 items',
        dateObserved: '2026-07-28T09:00:00.000Z',
        bytes: 48213,
        summary: 'A demonstration report: per-model scores with judge notes for each miss.',
      },
      { needsOwnerAuthorization: true, title: 'Example locked report', authorizationReason: 'This example stays locked until you authorize it — exactly how a private report behaves.' },
    ],
  },
  methodNotes: {
    ok: true,
    value: [
      { title: 'Hold the prompt fixed', guidance: 'Change one variable per cell. A prompt edit mid-sweep makes every earlier cell incomparable.' },
      { title: 'Judge twice on borderline', guidance: 'Send low-margin answers to a second judge before counting them.' },
    ],
  },
  findingsRegister: { ok: true, value: [{ status: 'supported', claim: 'Retrying after a timeout recovered nine of eleven failed runs in this example.' }] },
  failureTaxonomy: { ok: true, value: [{ count: 7, label: 'judge timeout (example category)' }] },
  openQuestions: { ok: true, value: [{ question: 'Does temperature zero flatten judge disagreement in this example set?', methodToClose: 'Re-run the borderline set at temperature zero and compare.' }] },
})

/* The project-findings block used to vanish from the example face, which made
   the mock page poorer than the live one — a visitor never learned the module
   existed. These feed the SAME observation renderer the projection's own
   findings register uses ({ok, reason, value}); the live block's per-project
   read (readFindings) is deliberately not imitated, because the example world
   has no service to read and pretending one answered is the lie this page
   exists to avoid. */
const SAMPLE_PROJECT_FINDINGS = Object.freeze({
  ok: true,
  reason: null,
  value: [
    { status: 'confirmed', claim: 'Pinning the judge model per lane removed the cross-lane drift in this example sweep — scores now move only when the model under test changes.' },
    { status: 'open', claim: 'The retry gate may double-count judge timeouts; this example question waits on a sweep run with that gate held open.' },
    { status: 'refuted', claim: 'Warming the strong tier before a sweep changed nothing here — the first-run lag was the loader, not the model.' },
  ],
})

const SAMPLE_EXPERIMENT = Object.freeze({
  id: 'sample-experiment',
  name: 'Example sweep — two tiers, two repeats',
  axes: [{ id: 'tier', values: ['luna', 'terra'] }],
  runner: { kind: 'agent', briefTemplate: 'Summarize the dataset at {dataset} in three sentences.' },
  resultSchema: { fields: { answer: 'string' }, required: [] },
  runsPerCell: 2,
  datasetPath: 'C:\\examples\\dataset.jsonl',
  projectId: null,
  serviceExperimentId: null,
  createdAtMs: 0,
  treeId: null,
  /* One cell in each state a person will actually meet — finished, running,
     failed, queued — so the run board, the results table, AND the status pulse
     all have something honest to show on the example face. The pulse in
     particular reads "1 running · 1 queued · 1 finished" from exactly these
     rows; an all-finished example left it saying almost nothing. */
  cells: [
    { params: { tier: 'luna', replicate: 1 }, status: 'finished', sessionId: null, nodeId: null, runId: null, startedAtMs: 0, endedAtMs: 41000, replyExcerpt: 'The example dataset holds 200 rows of paired prompts and answers.' },
    { params: { tier: 'luna', replicate: 2 }, status: 'running', sessionId: null, nodeId: null, runId: null, startedAtMs: 0, endedAtMs: null, replyExcerpt: '' },
    { params: { tier: 'terra', replicate: 1 }, status: 'failed', sessionId: null, nodeId: null, runId: null, startedAtMs: 0, endedAtMs: 12000, replyExcerpt: 'This example cell shows what a refused start looks like.' },
    { params: { tier: 'terra', replicate: 2 }, status: 'queued', sessionId: null, nodeId: null, runId: null, startedAtMs: null, endedAtMs: null, replyExcerpt: '' },
  ],
})

/* ---------- the designer's builder copy ----------
   One meaning per runner kind, spelled out where the person types. The select
   swaps this copy in place; the field itself never changes name, so the
   submit handler goes on reading form.elements.runnerDetail. */

const RUNNER_DETAIL_COPY = Object.freeze({
  agent: 'The task each session runs. Write {axis} tokens and {dataset} where values belong.',
  process: 'The command, then each argument on its own line.',
  http: 'The https address; {axis} tokens are filled per run.',
})

/* One axis the person is adding: its name, its comma-separated values, and
   the way out. The inputs carry data hooks, not names — duplicate names would
   turn form.elements lookups into lists under the submit handler's feet. */
function axisRowMarkup() {
  return `
    <div class="research-designer-row" data-axis-row>
      <input data-axis-name maxlength="32" placeholder="Axis name, like prompt_style." aria-label="Axis name"/>
      <input data-axis-values maxlength="800" placeholder="Values, separated by commas." aria-label="Axis values"/>
      <button type="button" class="research-row-btn" data-axis-remove>Remove</button>
    </div>`
}

function pinnedInputRowMarkup() {
  return `<div class="research-designer-row" data-pin-row>
    <input data-pin-path maxlength="1024" placeholder="Absolute file path" aria-label="Pinned input path"/>
    <input data-pin-sha256 maxlength="64" placeholder="Expected SHA-256 (64 hex characters)" aria-label="Pinned input SHA-256"/>
    <button type="button" class="research-row-btn" data-pin-remove>Remove</button>
  </div>`
}

/* One result column: its name, what it holds in a person's words (the stored
   kind rides on the option value where only the program reads it), and
   whether every run must report it. */
function columnRowMarkup() {
  return `
    <div class="research-designer-row" data-col-row>
      <input data-col-name maxlength="32" placeholder="Column name, like score." aria-label="Column name"/>
      <select data-col-kind aria-label="What the column holds">
        <option value="string">words</option>
        <option value="number">a number</option>
        <option value="boolean">yes or no</option>
      </select>
      <label class="research-popover-row"><input type="checkbox" data-col-required/><span>Required</span></label>
      <button type="button" class="research-row-btn" data-col-remove>Remove</button>
    </div>`
}

/* ---------- the starter templates ----------
   Two worked examples a person can start from instead of a blank form. Each
   only PREFILLS the designer — the sentence on every one says so, and nothing
   is saved until the person reads the form and presses Save. */

const DESIGNER_TEMPLATES = Object.freeze({
  command: Object.freeze({
    name: 'Compare a command across settings',
    runnerKind: 'process',
    runnerDetail: 'cmd.exe\n/c\necho {setting}',
    datasetPath: '',
    runsPerCell: 1,
    tiers: null,
    axisRows: Object.freeze([Object.freeze({ name: 'setting', values: 'first, second' })]),
    columnRows: Object.freeze([Object.freeze({ name: 'score', kind: 'number', required: false })]),
    sentence: 'An example is filled in. Change it to your command, then press Save the experiment — nothing is saved yet.',
  }),
  tiers: Object.freeze({
    name: 'Ask sessions across tiers',
    runnerKind: 'agent',
    runnerDetail: 'Answer in two sentences: what would you check first when a benchmark score drops?',
    datasetPath: '',
    runsPerCell: 1,
    tiers: null,
    axisRows: Object.freeze([]),
    columnRows: Object.freeze([]),
    sentence: 'An example is filled in. Change the question, then press Save the experiment — nothing is saved yet.',
  }),
})

/* ---------- the workbench ---------- */

/** Shared by both real service report surfaces; exported for a renderer-only
 * regression fixture which cannot connect to an owner's run service. */
export function serviceResultsTableMarkup(model) {
  return `
        <p class="research-observed-empty">Inputs and recorded results are separate. Collection and provenance hashes do not establish scientific validity or benchmark correctness. JSON preserves typed records and provenance; CSV protects formula-like text for spreadsheets.</p>
        ${[...new Set(model.rows.map(row => row.resultReadNote).filter(Boolean))].map(note => `<p class="research-unavailable projection-unavailable">${esc(note)}</p>`).join('')}
        <div class="research-results-scroll"><table class="research-results-table">
          <thead><tr>${model.columnMeta.map(column => `<th>${esc(column.label)}</th>`).join('')}<th>state</th><th>evidence</th></tr></thead>
          <tbody>${model.rows.map(row => `<tr>${row.cells.map(value => `<td>${esc(value ?? '—')}</td>`).join('')}<td>${esc(row.stateWord)}</td><td data-research-evidence="${esc(row.evidence.status)}" title="${esc(row.evidence.sentence)}">${esc(row.evidence.label)}</td></tr>`).join('')}</tbody>
        </table></div>`
}

export function researchView() {
  /* WHERE THE DATA COMES FROM — one axis, three answers ('local', 'relay',
     'mock'), resolved asynchronously in the boot below and re-resolved when
     the host announces a change (sign-in, sign-out, the example toggle). This
     replaced the per-view isLiveView('research') flag, whose off state used to
     select a second, poorer render; the owner's ruling — "all simulated pages
     ARE the UI pages, just mock data" — collapsed that to ONE render whose
     inputs differ. Null means "not yet resolved": the template below is
     therefore neutral (busy, unbadged, empty mast) until the first verdict
     lands, because defaulting to 'mock' would badge real data and defaulting
     to anything else would unbadge the example. */
  let source = null

  /* The mock mast names the example itself — the same fact home's badge states
     as "Example, not your data" — rather than pointing at a switch. On the
     website this face is simply what a signed-out visitor gets; there is no
     per-view "Live data" toggle any more for a sentence to send anyone to. */
  const EXAMPLE_MAST = 'example data — the product’s example, not your research'

  const root = el(`
    <main class="view-pad research-page" aria-busy="true" data-live-mode="">
      <div class="research-shell">
        <header class="research-mast">
          <div>
            <p class="research-eyebrow">your private research workbench</p>
            <h1>Research</h1>
          </div>
          <p class="research-source" data-research-source></p>
        </header>

        <div class="research-modules" data-research-modules>
          <section class="research-section" aria-labelledby="research-designer-title" data-mc="designer">
            <div class="research-section-head">
              <h2 id="research-designer-title">Experiment designer</h2>
              <p>Define a run: the task, the dataset path, the model tiers, and runs per tier. Workers start as nodes on the computers page.</p>
            </div>
            <div data-research-designer aria-live="polite">
              <p class="research-observed-empty">Reading your experiments.</p>
            </div>
          </section>

          <section class="research-section" aria-labelledby="research-runboard-title" data-mc="runboard">
            <div class="research-section-head">
              <h2 id="research-runboard-title">Run board</h2>
              <p>Every cell of a running experiment, with its live state. The workers themselves stream on the computers page.</p>
            </div>
            <div data-research-runboard aria-live="polite">
              <p class="research-observed-empty">Nothing is running yet.</p>
            </div>
          </section>

          <section class="research-section" aria-labelledby="research-results-title" data-mc="results">
            <div class="research-section-head">
              <h2 id="research-results-title">Results</h2>
              <p>What each cell answered, with timings. Copy a table out as CSV or JSON when you want it elsewhere.</p>
            </div>
            <div data-research-results aria-live="polite">
              <p class="research-observed-empty">No results have arrived yet.</p>
            </div>
          </section>

          <section class="research-section" aria-labelledby="research-tiers-title" data-mc="tiers">
            <div class="research-section-head">
              <h2 id="research-tiers-title">Local advisory tiers</h2>
              <p>What the two fixed local models on the computer you are driving can do right now, and the reason when one cannot.</p>
            </div>
            <div data-research-tiers aria-live="polite">
              <p class="research-observed-empty">Reading the local tiers.</p>
            </div>
          </section>

          <section class="research-section" aria-labelledby="research-queue-title" data-mc="queue" data-research-queue-section>
            <div class="research-section-head">
              <h2 id="research-queue-title">Research queue</h2>
              <p>Things you noticed that are waiting to be researched, each with its status and where it came from.</p>
            </div>
            <div data-research-queue data-queue-state="loading" aria-busy="true" aria-live="polite">
              <p class="research-observed-empty">Reading the research queue.</p>
            </div>
          </section>

          <section class="research-section" aria-labelledby="research-corpus-title" data-mc="library">
            <div class="research-section-head">
              <h2 id="research-corpus-title">Report library</h2>
              <p>Reports kept on the computer you are driving. Locked ones show only their title until you authorize them.</p>
            </div>
            <div data-research-library aria-live="polite">
              <p class="research-observed-empty">Reading the report catalog.</p>
            </div>
          </section>

          <section class="research-section" aria-labelledby="research-method-title" data-mc="methods">
            <div class="research-section-head">
              <h2 id="research-method-title">Method notes</h2>
              <p>The rules this research follows, written down alongside the reports rather than guessed from them.</p>
            </div>
            <div data-research-methods aria-live="polite">
              <p class="research-observed-empty">Reading the method notes.</p>
            </div>
          </section>

          <section class="research-section research-registers" aria-labelledby="research-registers-title" data-mc="worklists">
            <div class="research-section-head">
              <h2 id="research-registers-title">Working lists</h2>
              <p>What the research has found so far. A list that could not be read says so — it is never quietly shown as empty.</p>
            </div>
            <div data-research-worklists aria-live="polite">
              <p class="research-observed-empty">Reading the working lists.</p>
            </div>
          </section>

          <section class="research-section" aria-labelledby="research-sessions-title" data-mc="sessions">
            <div class="research-section-head">
              <h2 id="research-sessions-title">Assigned sessions</h2>
              <p>The sessions filed under the selected project — one, many, or every session on the computer you are driving through the assign-all rule. The sessions themselves run on the computers page.</p>
            </div>
            <div data-research-sessions aria-live="polite">
              <p class="research-observed-empty">Reading the session assignments.</p>
            </div>
          </section>

          <p class="research-observed-empty research-none-enabled" data-research-none hidden>
            Every module is switched off. Press Modules and switch one on.
          </p>
        </div>
      </div>
    </main>`)

  const shell = root.querySelector('.research-shell')
  const container = root.querySelector('[data-research-modules]')

  /* The bar and the popover are their own small templates: short button
     labels carry no sentence punctuation, and a page template that runs them
     into its prose reads as one impossible sentence to the language gate —
     and to a screen reader's continuous-read for that matter. */
  const bar = el(`
    <div class="research-bar" data-research-bar>
      <span class="research-queue-form-status" data-research-pulse role="status"></span>
      <span class="spacer"></span>
      <div class="research-project-dropdown" data-project-dropdown>
        <button type="button" class="m-edit-btn" data-projects-btn aria-expanded="false" aria-controls="research-project-options">Project: <span data-project-name>Empty draft</span><span aria-hidden="true">▾</span></button>
        <div class="research-project-options" id="research-project-options" data-projects-popover hidden>
          <h2>Choose a project</h2>
          <div data-project-drafts></div>
          <details data-account-project-options><summary>Account projects and storage</summary>
            <div class="research-project-bar" data-project-bar>
              <label class="research-popover-row">Account project
                <select data-project-select aria-label="Research account project" disabled><option value="all">All projects</option></select>
              </label>
              <button type="button" class="m-edit-btn" data-project-new hidden>New account project</button>
              <span class="research-queue-form-status" data-project-status role="status"></span>
            </div>
          </details>
        </div>
      </div>
      <span class="research-module-dropdown" data-module-dropdown><button type="button" class="m-edit-btn" data-modules-btn aria-expanded="false" aria-controls="research-module-options">Modules ▾</button></span>
      <button type="button" class="m-edit-btn" data-research-edit>Edit layout</button>
    </div>`)
  const popover = el(`
    <div class="research-popover" id="research-module-options" data-modules-popover hidden>
      <h3 id="research-popover-title">Workbench modules</h3>
      <div class="research-popover-list" data-modules-list role="group" aria-labelledby="research-popover-title"></div>
      <div class="research-popover-all">
        <button type="button" data-modules-all-on>All on</button>
        <button type="button" data-modules-all-off>All off</button>
      </div>
    </div>`)
  bar.querySelector('[data-module-dropdown]').append(popover)
  container.prepend(bar)
  const editBtn = bar.querySelector('[data-research-edit]')
  const modulesBtn = bar.querySelector('[data-modules-btn]')
  const projectsBtn = bar.querySelector('[data-projects-btn]')
  const projectsPopover = bar.querySelector('[data-projects-popover]')
  function setProjectsOpen(open) {
    projectsPopover.hidden = !open
    projectsBtn.setAttribute('aria-expanded', String(open))
    if (open) { popover.hidden = true; modulesBtn.setAttribute('aria-expanded', 'false') }
  }
  projectsBtn.addEventListener('click', () => setProjectsOpen(projectsPopover.hidden))
  const noneNote = root.querySelector('[data-research-none]')
  let destroyed = false
  let layout = null
  let workflow = null
  const workflowBar = el(`
    <div class="research-workflow">
      <div class="research-workflow-nav" data-workflow-nav role="group" aria-label="Research areas">
        ${RESEARCH_AREAS.filter(area => area.id !== 'all').map(area => `<button type="button" data-research-area="${area.id}" aria-pressed="false">${area.label}</button>`).join('')}
      </div>
      <p class="research-workflow-description" data-workflow-description></p>
      <p class="research-observed-empty" data-workflow-empty tabindex="-1" role="status" hidden></p>
    </div>`)
  bar.after(workflowBar)

  const benchmarkBuilder = createBenchmarkBuilder({
    separateProject: true,
    onDraftIdentity: draft => { const name = draft.name || 'Untitled draft'; projectsBtn.querySelector('[data-project-name]').textContent = name; projectsBtn.title = name },
    separateResource: true,
    onOpenResource: () => workflow.focusModule('resource', 'resources'),
    onWatchRuns: () => workflow.focusModule('runboard', 'run'),
    onBenchmarkLoaded: spec => {
      setProjectsOpen(false)
      if (spec.domain === 'lean-bench' || spec.id === 'lean-bench-snippets-and-compositions') registry.setActive(['data', 'benchmark', 'runboard', 'sessions', 'results', 'library'])
      else if (spec.experimentTemplate?.kind === 'resource-action-plan') registry.setActive(['data', 'benchmark', 'resource', 'runboard', 'sessions', 'results', 'library'])
    },
    onOpen: area => { setProjectsOpen(false); workflow.focusModule('benchmark', area) },
    account: typeof window === 'undefined' ? null : window.mcAccount,
    submitExported: async request => {
      if (source === 'mock') throw new Error('Example mode does not submit runs.')
      const contextEpoch = bootEpoch, contextProject = selection, contextAccountId = experimentsAccountId
      const isCurrent = () => !destroyed && contextEpoch === bootEpoch && contextProject === selection && contextAccountId === experimentsAccountId
      const requireCurrent = () => { if (!isCurrent()) throw new Error('The research project or account changed. Return to the original project to inspect its submission.') }
      const spec = await exportedBenchmarkExperiment({ ...request, projectId: selectedProject()?.projectId })
      requireCurrent()
      const existing = experimentsSnapshot().experiments.find(item => item.projectId === spec.projectId && item.name === spec.name && JSON.stringify(item.runner) === JSON.stringify(spec.runner))
      let id = existing?.id
      if (!id) {
        const saved = await commitExperimentChange(current => buildExperiment(spec, current), {
          persist: serialized => persistExperiments(serialized, contextAccountId), isCurrent,
        })
        requireCurrent()
        if (!saved.ok) throw new Error(saved.sentence)
        id = saved.experiment.id
      }
      const outcome = await submitExperimentRuns(id, { persist: serialized => { requireCurrent(); return persistExperiments(serialized, contextAccountId) }, projectId: spec.projectId, isCurrent })
      requireCurrent()
      renderExperimentModules(); refreshServiceSnapshot()
      if (!outcome.ok || outcome.sentence) throw new Error(outcome.sentence || 'The run service refused this submission.')
      workflow.focusModule('runboard', 'run')
    },
  })
  bar.querySelector('[data-project-drafts]').append(benchmarkBuilder.projectEl)
  const dataWorkspace = createResearchDataWorkspace({ openDraft: (data, name) => benchmarkBuilder.openDraft(data, name) })
  container.appendChild(dataWorkspace.el)
  container.appendChild(benchmarkBuilder.el)

  /* ---------- module registry ---------- */

  const MODULES = [
    { id: 'data', title: 'Files & data', size: 'full', el: dataWorkspace.el },
    { id: 'benchmark', title: 'Benchmark builder', size: 'full', el: benchmarkBuilder.el },
    { id: 'resource', title: 'Resource action', size: 'full', el: benchmarkBuilder.resourceEl, defaultOn: false },
    { id: 'designer', title: 'Experiment designer', size: 'full', el: root.querySelector('[data-mc="designer"]') },
    { id: 'runboard', title: 'Run board', size: 'full', el: root.querySelector('[data-mc="runboard"]') },
    { id: 'results', title: 'Results', size: 'full', el: root.querySelector('[data-mc="results"]') },
    { id: 'tiers', title: 'Local advisory tiers', size: 'full', el: root.querySelector('[data-mc="tiers"]') },
    { id: 'queue', title: 'Research queue', size: 'full', el: root.querySelector('[data-mc="queue"]') },
    { id: 'library', title: 'Report library', size: 'full', el: root.querySelector('[data-mc="library"]') },
    { id: 'methods', title: 'Method notes', size: 'full', el: root.querySelector('[data-mc="methods"]') },
    { id: 'worklists', title: 'Working lists', size: 'full', el: root.querySelector('[data-mc="worklists"]') },
    { id: 'sessions', title: 'Assigned sessions', size: 'full', el: root.querySelector('[data-mc="sessions"]') },
  ]
  const STANDARD = [['data'], ['benchmark'], ['resource'], ['designer'], ['runboard'], ['results'], ['sessions'], ['tiers'], ['queue'], ['library'], ['methods'], ['worklists']]
  const moduleEl = id => MODULES.find(module => module.id === id).el

  const registry = createResearchRegistry({
    modules: MODULES,
    storage: typeof window === 'undefined' ? null : window.localStorage,
    onChange: () => { if (!destroyed) { remount(); syncPopover() } },
  })

  /* ---------- layout mount ----------
     Only enabled modules are handed to the engine; the standard arrangement
     is the committed order filtered to what is enabled. Toggling a module
     changes the component set, so the persisted arrangement may no longer
     validate — the engine then falls back to this filtered standard, which
     is the honest reset rather than a guessed repair. */

  function mountLayout() {
    const enabled = registry.enabled()
    // The first mount still has every template section attached. Apply the
    // saved visibility before the all-off return, just as a remount does.
    for (const module of registry.all()) {
      if (!registry.isEnabled(module.id)) module.el.remove()
    }
    noneNote.hidden = enabled.length > 0
    editBtn.hidden = enabled.length === 0
    if (enabled.length === 0) { workflow?.apply(); return }
    const enabledIds = new Set(enabled.map(module => module.id))
    const standard = STANDARD.map(row => row.filter(id => enabledIds.has(id))).filter(row => row.length)
    for (const module of enabled) container.appendChild(module.el)
    layout = createMetricsLayout({
      container,
      filterRow: bar,
      editBtn,
      components: enabled.map(module => ({ id: module.id, title: module.title, el: module.el, size: module.size, headSelector: ':scope > .research-section-head' })),
      standard,
      storageKey: 'mc.research.layout',
      onArrange: () => workflow?.apply(),
      onEditChange: editing => workflow?.setLayoutEditing(editing),
    })
    workflow?.apply()
  }

  function unmountLayout() {
    layout?.destroy()
    layout = null
    container.classList.remove('m-editing')
    for (const chrome of container.querySelectorAll(':scope > .m-tray, :scope > .m-stash, :scope > .m-srow')) chrome.remove()
    for (const module of registry.all()) module.el.remove()
  }

  function remount() {
    const wasEditing = layout?.editing
    unmountLayout()
    mountLayout()
    if (wasEditing) layout?.setEdit(true)
  }

  workflow = createResearchWorkflow({
    root, container, registry, storage: window.localStorage,
    stopEditing: () => layout?.setEdit(false),
    onReveal: () => {
      for (const chart of serviceCharts.values()) chart.resize()
      for (const chart of gatheredCharts.values()) chart.resize()
    },
  })
  /* A page shows only its own builder steps (research-benchmark.css keys them
     on data-research-area). When the page changes and the builder's current
     step is not one of them, land on the page's first step; the builder's own
     click handler does the switching, nothing here touches its state. */
  const stepSync = new MutationObserver(() => {
    const steps = [...root.querySelectorAll('.bench-steps [data-bench-tab]')]
    const visible = steps.filter(button => button.offsetParent !== null)
    if (visible.length && !visible.some(button => button.getAttribute('aria-pressed') === 'true')) visible[0].click()
  })
  stepSync.observe(root, { attributes: true, attributeFilter: ['data-research-area'] })

  /* ---------- the Modules popover ---------- */

  function syncPopover() {
    modulesBtn.textContent = `Modules (${registry.enabled().length}/${registry.all().length}) ▾`
    const list = popover.querySelector('[data-modules-list]')
    list.innerHTML = registry.all().map(module => `
      <label class="research-popover-row">
        <input type="checkbox" data-module-toggle="${esc(module.id)}" ${registry.isEnabled(module.id) ? 'checked' : ''}/>
        <span>${esc(module.title)}</span>
      </label>`).join('')
  }

  function setPopoverOpen(open) {
    if (open) setProjectsOpen(false)
    popover.hidden = !open
    modulesBtn.setAttribute('aria-expanded', open ? 'true' : 'false')
    if (open) {
      syncPopover()
      popover.style.maxHeight = ''
      if (getComputedStyle(popover).overflowY === 'auto') {
        // The phone page clips below its navigation. Bound the menu to that
        // actual clip, including Safari's different CSS-zoom DOMRect behavior.
        const rect = popover.getBoundingClientRect()
        const scale = rect.width / popover.offsetWidth || 1
        let bottom = root.getBoundingClientRect().bottom
        for (let parent = popover.parentElement; parent; parent = parent.parentElement) {
          if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) {
            bottom = Math.min(bottom, parent.getBoundingClientRect().bottom)
          }
        }
        popover.style.maxHeight = `${Math.max(44, (bottom - rect.top) / scale - 16)}px`
      }
    }
  }

  modulesBtn.addEventListener('click', () => setPopoverOpen(popover.hidden))
  popover.addEventListener('change', event => {
    const id = event.target?.dataset?.moduleToggle
    if (id) registry.setEnabled(id, event.target.checked)
  })
  popover.querySelector('[data-modules-all-on]').addEventListener('click', () => registry.setAll(true))
  popover.querySelector('[data-modules-all-off]').addEventListener('click', () => registry.setAll(false))
  const onDocPointer = event => {
    if (!projectsPopover.hidden && !bar.querySelector('[data-project-dropdown]').contains(event.target)) setProjectsOpen(false)
    if (popover.hidden) return
    if (popover.contains(event.target) || modulesBtn.contains(event.target)) return
    setPopoverOpen(false)
  }
  const onDocKey = event => {
    if (event.key !== 'Escape') return
    if (!projectsPopover.hidden) { setProjectsOpen(false); projectsBtn.focus() }
    if (!popover.hidden) { setPopoverOpen(false); modulesBtn.focus() }
  }
  document.addEventListener('pointerdown', onDocPointer)
  document.addEventListener('keydown', onDocKey)

  /* ---------- module renderers ----------
     Renderers write into their module's element whether or not it is mounted:
     a disabled module keeps its element alive off-DOM, so switching it back
     on shows the data that already arrived instead of a stuck loading line. */

  function renderResearchQueue(result) {
    const host = root.querySelector('[data-research-queue]') || moduleEl('queue').querySelector('[data-research-queue]')
    if (!host) return
    host.dataset.queueState = result?.ok ? 'ready' : 'unavailable'
    host.setAttribute('aria-busy', 'false')
    host.innerHTML = researchQueueMarkup(result)
  }

  /* ---------- the writable queue (real data only — mock renders read-only) ----------
     The shipped catalog renders read-only; the researcher's own notes and the
     status overrides for shipped items live in ONE account row
     (research_queue, src/research-queue-store.js). The two halves fail
     independently: a broken shipped file still shows your notes, and a
     signed-out session still shows the shipped catalog with a sentence in
     place of the form. */

  const account = typeof window === 'undefined' ? null : window.mcAccount
  let queueRow = { items: [], statusOverrides: {}, damaged: false }
  let queueSignedOut = false
  let queueAccountRefusal = ''
  let authoredQueue = null

  async function readQueueRow() {
    queueAccountRefusal = ''
    if (!account?.getSetting) { queueSignedOut = true; return }
    let read = null
    try { read = await account.getSetting(RESEARCH_QUEUE_ROW_KEY) } catch {}
    if (!read || read.ok !== true) {
      queueSignedOut = true
      queueAccountRefusal = read?.reason || 'Your saved notes could not be read. Check the account connection on this computer and try again.'
      return
    }
    queueSignedOut = false
    queueRow = parseQueueRow(typeof read.value === 'string' ? read.value : null)
  }

  async function persistQueueRow(serialized) {
    if (!account?.putSetting) return { ok: false, sentence: 'Sign in to keep notes — they belong to your account.' }
    let result = null
    try { result = await account.putSetting(RESEARCH_QUEUE_ROW_KEY, serialized) } catch {}
    if (!result || result.ok !== true) {
      /* The shell's own reason, not a guess about it -- a full settings store
         or a damaged partition cannot be fixed by signing in again, and
         persist() already took the true signed-out branch above this one. */
      return { ok: false, sentence: saveRefusalSentence(result) }
    }
    return { ok: true }
  }

  /* THE QUEUE'S HIDDEN SET -- shipped items a person has taken off this
     screen. One key, never the ledger's: the ids are a different namespace. */
  const QUEUE_HIDDEN_KEY = 'mc.research.queue-hidden'
  const queueHidden = createHiddenRows(QUEUE_HIDDEN_KEY)
  let showHiddenQueue = false

  function queueControlsMarkup(item) {
    const to = nextStatus(item.status)
    /* The Remove button that used to sit here for own items is now the × in
       the title row (queueRemoveMarkup), one control for both kinds of item;
       the advance control stays. */
    return `
      <div class="research-queue-controls">
        ${to ? `<button type="button" data-queue-advance="${esc(item.id)}" data-queue-status="${esc(item.status)}" data-queue-own="${item.own ? 'true' : 'false'}">Move to ${esc(to === 'in-progress' ? 'in progress' : to)}</button>` : ''}
      </div>`
  }

  /* EVERY ITEM GETS A ×, and what it does follows whose item it is
     (data-queue-own). A hidden shipped item drawn on request gets the
     put-back control instead. */
  function queueRemoveMarkup(item, { hidden = false } = {}) {
    if (hidden) {
      return `<button type="button" class="research-queue-x" data-queue-unhide="${esc(item.id)}" aria-label="${esc(`Put “${item.title}” back in this queue`)}" title="Put back in this queue">↩</button>`
    }
    return `<button type="button" class="research-queue-x" data-queue-remove="${esc(item.id)}" data-queue-own="${item.own ? 'true' : 'false'}" data-queue-title="${esc(item.title)}" aria-label="${esc(`Remove “${item.title}” from this queue`)}" title="${item.own ? 'Remove from this queue' : 'Hide from this queue'}">×</button>`
  }

  function queueFormMarkup() {
    if (queueSignedOut) {
      if (queueAccountRefusal) return `<p class="research-observed-empty">${esc(queueAccountRefusal)}</p>`
      return '<p class="research-observed-empty">Sign in to write notes here — they are kept with your account.</p>'
    }
    return `
      <form class="research-queue-form" data-queue-form>
        <input name="title" maxlength="240" placeholder="What did you notice? A short title." aria-label="Title"/>
        <textarea name="observation" maxlength="2000" rows="2" placeholder="The observation, in your words." aria-label="Observation"></textarea>
        <textarea name="researchQuestion" maxlength="1000" rows="2" placeholder="The question that would settle it." aria-label="Research question"></textarea>
        <div class="research-queue-form-row">
          <button type="submit">Add to the queue</button>
          <span class="research-queue-form-status" data-queue-form-status role="status"></span>
        </div>
      </form>`
  }

  function renderQueueModuleLive() {
    const host = moduleEl('queue').querySelector('[data-research-queue]')
    if (!host) return
    const authoredItems = authoredQueue?.ok ? authoredQueue.items : []
    const rejected = authoredQueue?.ok ? authoredQueue.rejected : []
    const merged = mergeQueueForRender(authoredItems, queueRow)
    const shippedNote = authoredQueue && !authoredQueue.ok
      ? unavailableMarkup('The shipped research queue', authoredQueue.reason)
      : ''
    const rejectionNote = rejected.length === 0 ? '' : `
      <aside class="research-unavailable research-queue-rejections" data-research-queue-rejections role="status">
        <p><strong>${esc(`${rejected.length} shipped queue ${rejected.length === 1 ? 'item was' : 'items were'} rejected.`)}</strong></p>
        <ol>${rejected.map(item => `
          <li>Source index ${esc(item?.index)}${typeof item?.id === 'string' ? ` · id ${esc(item.id)}` : ''}: ${esc(item?.reason || 'invalid queue item')}</li>`).join('')}
        </ol>
      </aside>`
    const damagedNote = queueRow.damaged
      ? '<p class="research-unavailable projection-unavailable">Your saved notes could not be read, so only the shipped queue is shown. New notes will overwrite the unreadable ones.</p>'
      : ''
    /* Hidden shipped items leave the list here; own notes are never in the
       hidden set (the × on them deletes), so the filter cannot eat one. */
    const hiddenIds = new Set(queueHidden.list())
    const shown = merged.filter(item => !hiddenIds.has(item.id))
    const hiddenCount = merged.length - shown.length
    const drawn = showHiddenQueue ? merged : shown
    const hiddenLine = hiddenCount === 0 ? '' : `
      <p class="research-queue-hidden-note" data-queue-hidden-note>${hiddenCount} hidden · <button type="button" class="research-queue-show-hidden" data-queue-show-hidden aria-pressed="${showHiddenQueue ? 'true' : 'false'}">${showHiddenQueue ? 'Hide them again' : 'Show hidden'}</button></p>`
    const list = drawn.length === 0
      ? '<p class="research-observed-empty">No research items are queued.</p>'
      : `<ol class="research-catalog" data-research-queue-list>${drawn.map(item => {
          const hidden = hiddenIds.has(item.id)
          return queueItemMarkup(item, hidden ? '' : queueControlsMarkup(item), queueRemoveMarkup(item, { hidden }))
        }).join('')}</ol>`
    host.dataset.queueState = 'ready'
    host.setAttribute('aria-busy', 'false')
    host.innerHTML = `${queueFormMarkup()}${damagedNote}${shippedNote}${rejectionNote}${hiddenLine}${list}`
    for (const li of host.querySelectorAll('[data-research-queue-item]')) {
      if (hiddenIds.has(li.dataset.researchQueueItem)) li.setAttribute('data-queue-hidden', '')
    }
  }

  moduleEl('queue').addEventListener('submit', async event => {
    if (!event.target?.hasAttribute?.('data-queue-form')) return
    event.preventDefault()
    const form = event.target
    const status = form.querySelector('[data-queue-form-status]')
    const built = buildOwnItem({
      title: form.elements.title.value,
      observation: form.elements.observation.value,
      researchQuestion: form.elements.researchQuestion.value,
    }, queueRow)
    if (!built.ok) { if (status) status.textContent = built.sentence; return }
    const saved = await persistQueueRow(built.serialized)
    if (!saved.ok) { if (status) status.textContent = saved.sentence; return }
    queueRow = { ...built.next, damaged: false }
    renderQueueModuleLive()
  })

  /* The queue's status line for the × -- the nearest card's own slot, so the
     sentence sits by the control it explains. */
  function queueItemStatus(button) {
    const card = button.closest('[data-research-queue-item]')
    if (!card) return null
    let slot = card.querySelector('[data-queue-x-status]')
    if (!slot) {
      slot = document.createElement('p')
      slot.className = 'research-queue-x-status'
      slot.setAttribute('data-queue-x-status', '')
      slot.setAttribute('role', 'status')
      card.querySelector('.research-report-body')?.append(slot)
    }
    return slot
  }

  moduleEl('queue').addEventListener('click', async event => {
    const showHiddenButton = event.target?.closest?.('[data-queue-show-hidden]')
    if (showHiddenButton) {
      showHiddenQueue = !showHiddenQueue
      renderQueueModuleLive()
      return
    }
    const unhideId = event.target?.dataset?.queueUnhide
    if (unhideId) {
      queueHidden.remove(unhideId)
      renderQueueModuleLive()
      return
    }
    const advanceId = event.target?.dataset?.queueAdvance
    const removeId = event.target?.dataset?.queueRemove
    if (!advanceId && !removeId) return
    /* (written `removeId && !advanceId` rather than the bare test so the
       experiments test below, which slices the file at its own `if (removeId) {`,
       keeps finding the handler it measures) */
    if (removeId && !advanceId) {
      /* TWO PRESSES, AND THE FIRST SAYS WHICH OF TWO THINGS THE SECOND DOES.
         Your own note is deleted from your account's row; a shipped item is
         hidden on this screen only, because the catalog is not yours to edit
         (removeOwnItem's own refusal). The same arm helper the ledger × uses. */
      const button = event.target
      const own = button.dataset.queueOwn === 'true'
      const title = button.dataset.queueTitle || removeId
      const slot = queueItemStatus(button)
      if (!armOnce(button, { onDisarm: () => { if (slot) slot.textContent = '' } })) {
        if (slot) {
          slot.textContent = own
            ? `Remove “${title}”? Press × again. It is deleted from your account's notes; the shipped queue is unchanged.`
            : `Hide “${title}”? Press × again. It is hidden on this screen only — shipped items stay in the catalog.`
        }
        return
      }
      if (!own) {
        queueHidden.add(removeId)
        renderQueueModuleLive()
        return
      }
    }
    const result = advanceId
      ? advanceItem(queueRow, {
          id: advanceId,
          own: event.target.dataset.queueOwn === 'true',
          currentStatus: event.target.dataset.queueStatus,
        })
      : removeOwnItem(queueRow, removeId)
    /* A refusal under the × goes to the card's status slot, not into a 22px
       button that cannot hold a sentence; the advance button keeps its old
       in-place sentence. */
    const say = sentence => {
      const slot = removeId ? queueItemStatus(event.target) : null
      if (slot) slot.textContent = sentence
      else event.target.textContent = sentence
    }
    if (!result.ok) { say(result.sentence); return }
    const saved = await persistQueueRow(result.serialized)
    if (!saved.ok) { say(saved.sentence); return }
    queueRow = { ...result.next, damaged: false }
    renderQueueModuleLive()
  })

  function renderLibrary(catalog) {
    const host = moduleEl('library').querySelector('[data-research-library]')
    host.innerHTML = !catalog?.ok
      ? unavailableMarkup('Corpus catalog', catalog?.reason)
      : !Array.isArray(catalog.value) || catalog.value.length === 0
        ? emptyMarkup('reports')
        : `<ol class="research-catalog">${catalog.value.map(report => report?.needsOwnerAuthorization === true
            ? lockedReportMarkup(report)
            : safeReportMarkup(report)).join('')}</ol>`
  }

  function renderMethods(notes) {
    const host = moduleEl('methods').querySelector('[data-research-methods]')
    host.innerHTML = !notes?.ok
      ? unavailableMarkup('Method notes', notes?.reason)
      : !Array.isArray(notes.value) || notes.value.length === 0
        ? emptyMarkup('method notes')
        : `<ol class="research-method-list">${notes.value.map((note, index) => `
            <li>
              <span class="research-method-index">${String(index + 1).padStart(2, '0')}</span>
              <div><h3>${esc(note?.title || 'Untitled method note')}</h3><p>${esc(note?.guidance || 'Guidance unavailable.')}</p></div>
            </li>`).join('')}</ol>`
  }

  function renderWorklists(data) {
    const host = moduleEl('worklists').querySelector('[data-research-worklists]')
    host.innerHTML = `
      <div class="research-register-row">
        <h3>Findings</h3>
        <div>${observationMarkup(data.findingsRegister, { label: 'The findings list', emptyLabel: 'findings', itemMarkup: findingMarkup })}</div>
      </div>
      <div class="research-register-row">
        <h3>Failure categories</h3>
        <div>${observationMarkup(data.failureTaxonomy, { label: 'The failure-category list', emptyLabel: 'failure categories', itemMarkup: taxonomyMarkup })}</div>
      </div>
      <div class="research-register-row">
        <h3>Open questions</h3>
        <div>${observationMarkup(data.openQuestions, { label: 'The open-question list', emptyLabel: 'open questions', itemMarkup: questionMarkup })}</div>
      </div>`
    /* The project-findings block survives this rewrite: it is one element,
       re-appended with whatever the findings read last said. It rides along on
       every source now — the example face fills it from SAMPLE_PROJECT_FINDINGS
       instead of hiding the module (renderFindingsList owns that fork). */
    host.appendChild(findingsBlock)
  }

  // A failed read does not establish that the catalog was never shipped. Only
  // the validated, empty release placeholder gets the absence explanation.
  // Neither state prints the envelope's internal reason or source paths.
  const CATALOG_UNAVAILABLE = Object.freeze({
    mast: 'report library unavailable; reopen this page to try again',
    library: 'The report library could not be read. Try opening this page again.',
    methods: 'The method notes could not be read with the report library.',
    worklists: 'The catalog’s registers could not be read. The project findings below are read separately from this computer.',
    title: 'Open this page again to retry the report library',
    bench: 'Projects, experiments and results below are read separately from this computer.',
  })
  const CATALOG_ABSENT = Object.freeze({
    mast: 'no report library on this computer',
    library: 'A report library is a set of documents kept for research, and this copy was not shipped with one. Nothing on this computer is missing or broken.',
    methods: 'The method notes are written alongside those documents, so there are none here either.',
    worklists: 'The catalog’s own registers come with those documents. The project findings below are read live from this computer.',
    title: 'There is no report library in this copy',
    bench: 'Everything below is read live from this computer and is not affected.',
  })

  function renderUnavailable(result) {
    const envelope = result?.data
    const unshipped = envelope?.ok === false
      && envelope.generatedAt === '1970-01-01T00:00:00.000Z'
      && envelope.reason === 'No local agent fleet host detected on this machine.'
      && envelope.data === null
      && Array.isArray(envelope.sources) && envelope.sources.length === 0
    const copy = unshipped ? CATALOG_ABSENT : CATALOG_UNAVAILABLE
    root.setAttribute('aria-busy', 'false')
    root.dataset.projectionState = 'unavailable'
    root.querySelector('[data-research-source]').textContent = copy.mast
    const settle = (id, selector, sentence) => {
      // Disabled modules are detached but must be ready when switched on.
      const loading = moduleEl(id).querySelector(`${selector} p.research-observed-empty`)
      if (loading && (/^Reading /.test(loading.textContent || '') || loading.hasAttribute('data-research-catalog-status'))) {
        loading.textContent = sentence
        loading.setAttribute('data-research-catalog-status', '')
      }
    }
    settle('library', '[data-research-library]', copy.library)
    settle('methods', '[data-research-methods]', copy.methods)
    settle('worklists', '[data-research-worklists]', copy.worklists)
    root.querySelector('.research-mast').insertAdjacentHTML('afterend', `
      <section class="research-envelope-unavailable projection-state projection-unavailable" data-research-unavailable role="status">
        <strong>${esc(copy.title)}</strong>
        <span>${esc(copy.library)}</span>
        <span>${esc(copy.bench)}</span>
        <a class="host-absent-action" href="${esc(GUIDE_ACTION.href)}">${esc(GUIDE_ACTION.label)}</a>
      </section>`)
  }

  function renderProjection(envelope) {
    const data = envelope.data
    root.setAttribute('aria-busy', 'false')
    root.dataset.projectionState = 'ready'
    /* The badge rule lives in one place (sourceIsBadged): a badged source keeps
       the example sentence in the mast; real data — local and relay alike —
       gets the catalog's own date and no marking. */
    if (!sourceIsBadged(source)) {
      root.querySelector('[data-research-source]').textContent = `catalog generated ${formatDate(envelope.generatedAt)}`
    }
    renderLibrary(data.corpusCatalog)
    renderMethods(data.methodNotes)
    renderWorklists(data)
  }

  /* ---------- the experiment bench ----------
     Specs and results live in the research_experiments account row through
     src/research-experiments.js, which also owns the dispatcher and the
     module-level results listener. This view only renders snapshots and
     forwards presses; nothing here holds worker state of its own. */

  let experimentsSignedOut = false
  let experimentsAccountRefusal = ''
  let experimentsAccountId = null

  function seedAccountExperiments(parsed, readCheckpoint) {
    const accountId = experimentsAccountId
    seedExperiments(parsed, { accountId, readCheckpoint,
      persist: serialized => account.putSetting(RESEARCH_EXPERIMENTS_ROW_KEY, serialized, { expectedAccountId: accountId }),
      agent: typeof window === 'undefined' ? null : window.mcAgent,
      transcripts: typeof window === 'undefined' ? null : window.mcTranscripts,
    })
  }

  async function readExperimentsRow() {
    const epoch = bootEpoch, readCheckpoint = experimentsReadCheckpoint()
    experimentsAccountRefusal = ''
    experimentsAccountId = null
    if (!account?.getSetting) { experimentsSignedOut = true; seedExperiments({ experiments: [], damaged: false }); return }
    let read = null
    try { read = await account.getSetting(RESEARCH_EXPERIMENTS_ROW_KEY) } catch {}
    if (destroyed || epoch !== bootEpoch) return
    if (!read || read.ok !== true) {
      experimentsSignedOut = true
      experimentsAccountRefusal = read?.reason || 'Your saved experiments could not be read. Check the account connection on this computer and try again.'
      seedExperiments({ experiments: [], damaged: false })
      return
    }
    if (typeof read.accountId !== 'string' || !read.accountId.length) {
      experimentsSignedOut = true
      experimentsAccountRefusal = 'This connection could not confirm which account owns your experiments. Reconnect to the current app and try again.'
      seedExperiments({ experiments: [], damaged: false })
      return
    }
    experimentsSignedOut = false
    experimentsAccountId = read.accountId
    seedAccountExperiments(parseExperimentsRow(typeof read.value === 'string' ? read.value : null), readCheckpoint)
  }

  async function persistExperiments(serialized, expectedAccountId = experimentsAccountId) {
    if (!account?.putSetting || !expectedAccountId) return { ok: false, sentence: 'Sign in to keep experiments — they belong to your account.' }
    let result = null
    try { result = await account.putSetting(RESEARCH_EXPERIMENTS_ROW_KEY, serialized, { expectedAccountId }) } catch {}
    /* Same rule as persistQueueRow above: the shell's own reason, not a
       fixed line that tells a full store or a damaged partition to sign in. */
    if (!result || result.ok !== true) return { ok: false, sentence: saveRefusalSentence(result) }
    return { ok: true }
  }

  const CELL_WORD = Object.freeze({
    designed: 'designed', starting: 'starting', running: 'running', finished: 'finished',
    unconfirmed: 'session not confirmed',
    failed: 'failed', queued: 'queued', unread: 'with the run service',
    claimed: 'claimed', retrying: 'waiting to retry', cancelled: 'cancelled',
    uncertain: 'uncertain', stalled: 'stalled',
    dispatched: 'dispatched · awaiting results', collected: 'results collected',
    executed: 'executed · no collected results', unverified: 'completed · unverified',
  })

  function cellDuration(cell) {
    if (!Number.isFinite(cell.startedAtMs) || !Number.isFinite(cell.endedAtMs)) return ''
    const seconds = Math.max(0, Math.round((cell.endedAtMs - cell.startedAtMs) / 1000))
    return `${seconds}s`
  }

  function tierWord(id) {
    return TIER_CHOICES.find(choice => choice.id === id)?.label || id
  }

  /* cellLabel with the tier value spelled as its human word. */
  function cellWords(experiment, cell) {
    const parts = experiment.axes.map(axis => axis.id === 'tier' ? tierWord(cell.params[axis.id]) : String(cell.params[axis.id]))
    if (Object.hasOwn(cell.params, 'replicate')) parts.push(`#${cell.params.replicate}`)
    return parts.join(' · ')
  }

  function runControlWord(experiment) {
    return decideDispatch(experiment).mode === 'local' ? 'Run here as sessions' : 'Send to the run queue'
  }

  /* ---------- the gathered view ----------
     One experiment, one place: its local cells, its queued service runs with
     their drill rows, its results table with chart and exports — inline under
     the card, so a person tracks a run without touring four modules. The
     panel reuses the boards' own markup builders; nothing is duplicated and
     nothing is removed from the boards themselves. */

  let gatheredExperimentId = null
  let lastKnownPulse = null          // the last counts read whole; see renderStatusPulse
  let workerPending = null           // 'start' | 'stop' while a lifecycle call is in flight
  /* The column a person chose to chart, per service experiment. The results
     block re-renders on every run poll (~5s), and each re-render used to
     rebuild the picker at its default: pick sd_of_mean, and it snapped back
     to mean before the sentence explaining it was finished (installed
     1.0.15, 3.7s). The choice outlives the markup now. */
  const chartChoice = new Map()      // serviceExperimentId -> column name
  const chosenColumn = (experimentId, model, resultSchema) => {
    const columns = chartableColumns(model, resultSchema)
    const wanted = chartChoice.get(experimentId)
    return columns.find(candidate => candidate.name === wanted) || chartableColumn(model, resultSchema)
  }
  const gatheredCharts = new Map()   // experimentId -> { resize, destroy }

  function localCellsMarkup(experiment, cells = experiment.cells) {
    return cells.map(cell => `
      <span class="research-cell is-${esc(cell.status)}">${esc(cellWords(experiment, cell))} · ${esc(CELL_WORD[cell.status] || cell.status)}${cellDuration(cell) ? ` · ${cellDuration(cell)}` : ''}</span>`).join('')
  }

  function localCopyControlsMarkup(experiment) {
    return `
          <div class="research-queue-controls">
            <button type="button" data-results-csv="${esc(experiment.id)}">Copy as CSV</button>
            <button type="button" data-results-json="${esc(experiment.id)}">Copy as JSON</button>
          </div>`
  }

  function localResultsTableMarkup(experiment) {
    return `
        <p class="research-observed-empty">Session replies are recorded output, not independently verified research findings.</p>
        <div class="research-results-scroll"><table class="research-results-table">
          <thead><tr>${experiment.axes.map(axis => `<th>${esc(axis.id)}</th>`).join('')}<th>repeat</th><th>state</th><th>took</th><th>answer</th></tr></thead>
          <tbody>
            ${experiment.cells.map(cell => `
              <tr>${experiment.axes.map(axis => `<td>${esc(cell.params[axis.id] ?? '—')}</td>`).join('')}<td>${cell.params.replicate ?? 1}</td><td>${esc(cell.status)}</td><td>${esc(cellDuration(cell) || '—')}</td><td>${esc(cell.replyExcerpt || '—')}</td></tr>`).join('')}
          </tbody>
        </table></div>`
  }

  function gatheredServicePlaceholder(experiment) {
    if (experiment.serviceExperimentId) {
      return '<p class="research-observed-empty">Reading its queued runs.</p>'
    }
    if (decideDispatch(experiment).mode === 'local') {
      return '<p class="research-observed-empty">Its workers run here as sessions; nothing waits in the run queue.</p>'
    }
    return '<p class="research-observed-empty">Nothing has been sent to the run queue yet. Press its run control to queue it.</p>'
  }

  function gatheredPanelMarkup(experiment) {
    const hasLocalResults = experiment.cells.some(cell => cell.status === 'finished' || cell.status === 'failed')
    return `
      <div class="research-gathered" data-exp-gathered="${esc(experiment.id)}">
        <div class="research-report-head">
          <h4>Everything about this experiment</h4>
          <div class="research-queue-controls">
            <button type="button" data-exp-close="${esc(experiment.id)}">Close</button>
          </div>
        </div>
        <div class="research-gathered-block">
          <h5>Cells on the computer you are driving</h5>
          <div class="research-runboard-cells" data-gathered-cells="${esc(experiment.id)}">${localCellsMarkup(experiment, experiment.serviceExperimentId ? cellsAwaitingService(experiment) : experiment.cells)}</div>
        </div>
        ${hasLocalResults ? `
        <div class="research-gathered-block">
          <h5>Results from here</h5>
          <div class="research-results-exp">
            ${localCopyControlsMarkup(experiment)}
            ${localResultsTableMarkup(experiment)}
            <p class="research-queue-form-status" data-results-status="${esc(experiment.id)}" role="status"></p>
          </div>
        </div>` : ''}
        <div class="research-gathered-block">
          <h5>Queued through the service</h5>
          <div data-gathered-service="${esc(experiment.id)}">${gatheredServicePlaceholder(experiment)}</div>
        </div>
      </div>`
  }

  function toggleGathered(id) {
    gatheredExperimentId = gatheredExperimentId === id ? null : id
    renderDesigner()
  }

  /* ---------- duplicate and prefill ----------
     Duplicate copies an experiment INTO the form — axis rows, column rows,
     tiers, runner text — and stops there. The person reviews and presses
     Save; nothing writes until they do. The starter templates ride the same
     prefill path with worked example values. */

  function duplicateSpec(experiment) {
    const tierAxis = experiment.axes.find(axis => axis.id === 'tier')
    const axisRows = experiment.axes.filter(axis => axis.id !== 'tier')
      .map(axis => ({ name: axis.id, values: axis.values.join(', ') }))
    const fields = experiment.resultSchema?.fields || {}
    const required = new Set(experiment.resultSchema?.required || [])
    const fieldNames = Object.keys(fields)
    const standardColumns = fieldNames.length === 1 && fields.answer === 'string' && required.size === 0
    const columnRows = standardColumns ? [] : fieldNames.map(name => ({ name, kind: fields[name], required: required.has(name) }))
    return {
      name: experiment.name,
      ...runnerDesignerFields(experiment.runner),
      datasetPath: experiment.datasetPath || '',
      runsPerCell: experiment.runsPerCell,
      tiers: tierAxis ? tierAxis.values : null,
      axisRows,
      columnRows,
      moreAxes: JSON.stringify(Object.fromEntries(experiment.axes.filter(axis => axis.id !== 'tier').map(axis => [axis.id, axis.values])), null, 2),
      ...(experiment.agentSetup ? { agentSetup: experiment.agentSetup } : {}),
      sentence: 'Copied into the form. Change what you like, then press Save the experiment — nothing is saved yet.',
    }
  }

  const designerOriginalRunners = new WeakMap()
  let experimentImportRevision = 0

  function setDesignerRows(form, axisRows, columnRows) {
    const axisHost = form.querySelector('[data-axis-rows]')
    axisHost.innerHTML = ''
    for (const row of axisRows) {
      axisHost.insertAdjacentHTML('beforeend', axisRowMarkup())
      const added = axisHost.querySelector('[data-axis-row]:last-child')
      added.querySelector('[data-axis-name]').value = row.name
      added.querySelector('[data-axis-values]').value = row.values
    }
    const columnHost = form.querySelector('[data-col-rows]')
    columnHost.innerHTML = ''
    for (const row of columnRows) {
      columnHost.insertAdjacentHTML('beforeend', columnRowMarkup())
      const added = columnHost.querySelector('[data-col-row]:last-child')
      added.querySelector('[data-col-name]').value = row.name
      added.querySelector('[data-col-kind]').value = row.kind
      added.querySelector('[data-col-required]').checked = row.required === true
    }
  }

  function prefillDesigner(form, spec) {
    if (spec.originalRunner) {
      const checked = parseRunner(spec.originalRunner)
      if (!checked.ok) {
        const status = form.querySelector('[data-exp-form-status]')
        if (status) status.textContent = `This design could not be copied: ${checked.sentence}`
        return
      }
      designerOriginalRunners.set(form, spec.originalRunner)
    } else designerOriginalRunners.delete(form)
    form.elements.name.value = spec.name
    form.elements.runnerKind.value = spec.runnerKind
    form.elements.runnerDetail.value = spec.runnerDetail
    form.elements.datasetPath.value = spec.datasetPath || ''
    if (form.elements.agentSetupEnabled) {
      form.elements.agentSetupEnabled.checked = Boolean(spec.agentSetup)
      form.elements.agentSetupAccess.value = spec.agentSetup?.access || 'read-only'
      form.elements.agentSetupFiles.value = spec.agentSetup ? JSON.stringify(spec.agentSetup.files || [], null, 2) : ''
    }
    form.elements.moreAxes.value = spec.moreAxes || ''
    form.elements.resultColumns.value = ''
    form.elements.runnerOptions.value = spec.runnerOptions || ''
    form.dataset.runnerOptionsKind = spec.runnerKind
    const pinsHost = form.querySelector('[data-pin-rows]')
    pinsHost.innerHTML = ''
    for (const pin of spec.pinnedRows || []) {
      pinsHost.insertAdjacentHTML('beforeend', pinnedInputRowMarkup())
      const row = pinsHost.lastElementChild
      row.querySelector('[data-pin-path]').value = pin.path
      row.querySelector('[data-pin-sha256]').value = pin.sha256
    }
    if (spec.runnerOptions && spec.runnerOptions !== '{}') form.querySelector('[data-exp-advanced]').open = true
    form.elements.runsPerCell.value = String(spec.runsPerCell || 1)
    setDesignerRows(form, spec.axisRows || [], spec.columnRows || [])
    if (Array.isArray(spec.tiers)) {
      for (const input of form.querySelectorAll('input[name="tier"]')) input.checked = spec.tiers.includes(input.value)
    }
    syncRunnerDetail(form)
    updateDesignerPreview(form)
    const status = form.querySelector('[data-exp-form-status]')
    if (status) status.textContent = spec.sentence
    form.elements.name.focus()
  }

  function renderDesigner() {
    const host = moduleEl('designer').querySelector('[data-research-designer]')
    if (!host) return
    if (experimentsSignedOut) {
      if (experimentsAccountRefusal) {
        host.innerHTML = `<p class="research-observed-empty">${esc(experimentsAccountRefusal)}</p>`
        return
      }
      /* IT SAID "Sign in to design experiments" AND OFFERED NO WAY TO.
         The nearest sign-in was five steps away through Settings, and the
         sentence did not say where. A refusal that names a remedy has to carry
         the remedy, which is this product's own rule everywhere else. */
      host.innerHTML = '<p class="research-observed-empty">Experiments are kept with the account on the computer you are driving, so this needs somebody signed in. <a class="host-absent-action" href="#/account">Set up who is using this copy</a></p>'
      return
    }
    const { damaged } = experimentsSnapshot()
    const { shown: experiments, hidden } = benchExperiments()
    const damagedNote = damaged
      ? '<p class="research-unavailable projection-unavailable">Your saved experiments could not be read. New ones will overwrite the unreadable record.</p>'
      : ''
    const list = experiments.length === 0
      ? `<p class="research-observed-empty">No experiments are designed yet.</p>${elsewhereNote(hidden)}`
      : `${elsewhereNote(hidden)}<ol class="research-catalog">${experiments.map(experiment => `
          <li class="research-report" data-research-experiment="${esc(experiment.id)}">
            <div class="research-report-body">
              <div class="research-report-head">
                <h3>${esc(experiment.name)}</h3>
                <dl class="research-report-meta">
                  <div><dt>runs</dt><dd>${experiment.cells.length}</dd></div>
                  <div><dt>axes</dt><dd>${esc(experiment.axes.map(axis => `${axis.id} (${axis.values.length})`).join(', '))}</dd></div>
                </dl>
              </div>
              <div class="research-context"><p>${esc(experiment.runner.kind === 'agent' ? experiment.runner.briefTemplate.slice(0, 200) : experiment.runner.kind === 'process' ? `Runs a command: ${experiment.runner.command || ''}`.slice(0, 200) : `Calls ${experiment.runner.url || 'a web address'}`.slice(0, 200))}</p></div>
              ${experiment.datasetPath ? `<p class="research-authorization"><strong>Dataset:</strong> ${esc(experiment.datasetPath)}</p>` : ''}
              <div class="research-queue-controls">
                <button type="button" data-exp-run="${esc(experiment.id)}">${esc(runControlWord(experiment))}</button>
                <button type="button" data-exp-open="${esc(experiment.id)}">${experiment.id === gatheredExperimentId ? 'Close' : 'Open'}</button>
                <button type="button" data-exp-duplicate="${esc(experiment.id)}">Duplicate</button>
                <button type="button" data-exp-remove="${esc(experiment.id)}">Remove</button>
              </div>
              ${experiment.id === gatheredExperimentId ? gatheredPanelMarkup(experiment) : ''}
            </div>
          </li>`).join('')}</ol>`
    host.innerHTML = `
      <div class="research-queue-controls research-exp-templates" data-exp-templates>
        <span class="research-designer-hint">Start from an example:</span>
        <button type="button" data-exp-template="command">Compare a command across settings</button>
        <button type="button" data-exp-template="tiers">Ask sessions across tiers</button>
        <button type="button" data-exp-import>Import experiment file</button>
        <button type="button" data-exp-export>Download editable experiment file</button>
        <input type="file" accept="application/json,.json" data-exp-import-file hidden/>
      </div>
      <form class="research-queue-form" data-exp-form>
        <input name="name" maxlength="120" placeholder="Name this experiment." aria-label="Experiment name"/>
        <label class="research-popover-row">Runner
          <select name="runnerKind" aria-label="Runner kind">
            <option value="agent">Sessions</option>
            <option value="process">A command</option>
            <option value="http">A web address</option>
          </select>
        </label>
        <p class="research-designer-hint" data-runner-detail-label>${esc(RUNNER_DETAIL_COPY.agent)}</p>
        <textarea name="runnerDetail" maxlength="2000" rows="3" placeholder="${esc(RUNNER_DETAIL_COPY.agent)}" aria-label="What runs"></textarea>
        <div class="research-designer-group" data-pinned-inputs hidden>
          <p class="research-designer-hint">Optional pinned process inputs: declare literal file paths and expected SHA-256 digests. The service checks their bytes before and after the command. A missing or changed file refuses results. These checks do not prove in-run immutability, a cleanroom, or scientific correctness.</p>
          <div data-pin-rows></div>
          <button type="button" class="research-row-btn" data-pin-add>Add a pinned input</button>
        </div>
        <input name="datasetPath" maxlength="400" placeholder="Dataset path on the computer you are driving, if the task reads one. Workers read it under their own permissions." aria-label="Dataset path"/>
        <div class="research-designer-group" data-agent-setup>
          <label class="research-popover-row"><input type="checkbox" name="agentSetupEnabled"/> <span>Set up clean rooms for agents</span></label>
          <p class="research-designer-hint">Optional explicit files for each agent. You or an agent can prepare the file; inputs and outputs stay in the clean room after the agent stops.</p>
          <label class="research-popover-row">Access
            <select name="agentSetupAccess"><option value="read-only">Read only</option><option value="read-write">Read and write</option></select>
          </label>
          <textarea name="agentSetupFiles" rows="3" placeholder='Optional files JSON: [{"path":"input.txt","content":"..."}]' aria-label="Clean-room files"></textarea>
        </div>
        <div class="research-designer-tiers" role="group" aria-label="Model tiers">
          ${TIER_CHOICES.map(choice => `
            <label class="research-popover-row"><input type="checkbox" name="tier" value="${esc(choice.id)}" ${choice.id === DEFAULT_TIER ? 'checked' : ''}/><span>${esc(choice.label)}</span></label>`).join('')}
        </div>
        <div class="research-designer-group" role="group" aria-label="More axes">
          <p class="research-designer-hint">Vary more than the tier: add an axis, then write its values separated by commas.</p>
          <div class="research-designer-rows" data-axis-rows></div>
          <button type="button" class="research-row-btn" data-axis-add>Add an axis</button>
        </div>
        <div class="research-exp-preview" data-exp-preview role="status"></div>
        <div class="research-designer-group" role="group" aria-label="Result columns">
          <p class="research-designer-hint">Each run always keeps its answer. Add a column when a run should also report a named value.</p>
          <div class="research-designer-rows" data-col-rows></div>
          <button type="button" class="research-row-btn" data-col-add>Add a result column</button>
        </div>
        <details class="research-designer-advanced" data-exp-advanced>
          <summary>Advanced</summary>
          <p class="research-designer-hint">Text written here replaces the axis and column rows above.</p>
          <textarea name="moreAxes" rows="2" placeholder='More axes, optional, one object: {"prompt_style": ["terse", "full"]}' aria-label="More axes"></textarea>
          <input name="resultColumns" placeholder='Result columns, optional: {"fields": {"score": "number"}, "required": ["score"]}' aria-label="Result columns"/>
          <p class="research-designer-hint">Additional runner settings are preserved as written, including receipt options. Only settings supported by the service take effect. Do not put secrets here. Use the controls above for the command, address, task and pinned inputs.</p>
          <textarea name="runnerOptions" rows="3" placeholder='Optional runner settings, for example {"stdin":"params-json"}' aria-label="Additional runner settings"></textarea>
        </details>
        <div class="research-queue-form-row">
          <label class="research-popover-row">Repeats
            <select name="runsPerCell"><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option><option value="5">5</option></select>
          </label>
          <button type="submit">Save the experiment</button>
          <span class="research-queue-form-status" data-exp-form-status role="status"></span>
        </div>
      </form>
      ${damagedNote}${list}`
    const freshForm = host.querySelector('[data-exp-form]')
    if (freshForm) updateDesignerPreview(freshForm)
    const opened = experiments.find(candidate => candidate.id === gatheredExperimentId)
    if (opened?.serviceExperimentId) renderGatheredService(opened)
  }

  function renderRunBoard() {
    const host = moduleEl('runboard').querySelector('[data-research-runboard]')
    if (!host) return
    /* Own one child block, as renderResults does; the service board is a
       sibling this renderer must never be able to delete. */
    let block = host.querySelector('[data-bench-runboard]')
    if (!block) {
      block = el('<div data-bench-runboard></div>')
      claimHost(host, block)
    }
    const { shown: experiments, hidden } = benchExperiments()
    const active = experiments.filter(experiment => experiment.cells.some(cell => cell.status !== 'designed'))
    if (active.length === 0) {
      /* Only claim the board is idle when the service board beside it is
         idle too — the two blocks share a section heading and read as one. */
      const serviceIsBusy = serviceExperiments().some(experiment => {
        const read = runsByExperiment.get(experiment.experimentId)
        return read?.ok === true && read.runs.some(run => run?.task && !runIsTerminal(run.task.status))
      })
      block.innerHTML = `${serviceIsBusy ? '' : '<p class="research-observed-empty">Nothing is running yet. Save an experiment above, then press its Run control.</p>'}${elsewhereNote(hidden)}`
      renderServiceRunBoard()
      return
    }
    /* The header promises "with its live state", so a queue-dispatched cell
       must not sit here reading 'queued' while the service board below it
       says finished — the flagship experiment showed exactly that on the
       staged page. Same display-only translation the gathered panel uses;
       when the service has not been read, the local word stands unchanged. */
    const cellsFor = experiment => {
      if (!experiment.serviceExperimentId) return localCellsMarkup(experiment)
      const read = runsByExperiment.get(experiment.serviceExperimentId)
      return read?.ok === true
        ? localCellsMarkup(experiment, cellsWithServiceStatus(experiment, read.runs))
        : localCellsMarkup(experiment, cellsAwaitingService(experiment))
    }
    block.innerHTML = `${elsewhereNote(hidden)}${active.map(experiment => `
      <div class="research-runboard-exp" data-runboard-exp="${esc(experiment.id)}">
        <h3>${esc(experiment.name)}</h3>
        <div class="research-runboard-cells">
          ${cellsFor(experiment)}
        </div>
        <p class="research-observed-empty">Session workers are nodes on the computers page; queued runs report in the service board below.</p>
      </div>`).join('')}`
    /* The service board and the worker control are APPENDED into this same
       host, so the assignment above deletes them. Re-render them here rather
       than at every call site: saving an experiment used to make the service
       board and the Start button vanish until the page was reloaded — during
       a showing that is the finale button disappearing (measured on the
       installed build, 2026-08-15). */
    renderServiceRunBoard()
  }

  function renderResults() {
    const host = moduleEl('results').querySelector('[data-research-results]')
    if (!host) return
    /* Two renderers share this host: the bench results (local session cells)
       and the service results block appended by renderServiceResults. Writing
       host.innerHTML here deleted the service block, so saving or removing an
       experiment blanked every results table until something else happened
       to refresh them (installed 1.0.13, measured 90s+ blank). The same
       host-clobber had already hit the run board twice. This renderer now owns
       ONE child block and never touches its sibling; the class of bug is gone
       here rather than the instance. */
    let block = host.querySelector('[data-bench-results]')
    if (!block) {
      block = el('<div data-bench-results></div>')
      claimHost(host, block)
    }
    const { experiments } = experimentsSnapshot()
    const finished = experiments.filter(experiment => experiment.cells.some(cell => cell.status === 'finished' || cell.status === 'failed'))
    if (finished.length === 0) {
      /* "No results have arrived yet." printed above a page of service
         results tables (installed 1.0.13). Local cells and service runs are
         two sources; say which one is empty, and only when the other is too. */
      const serviceHasResults = serviceExperiments().some(experiment => {
        const read = runsByExperiment.get(experiment.experimentId)
        return read?.ok === true && read.runs.some(run => run?.task?.status === 'succeeded')
      })
      block.innerHTML = serviceHasResults ? '' : '<p class="research-observed-empty">No results have arrived yet.</p>'
      return
    }
    block.innerHTML = finished.map(experiment => `
      <div class="research-results-exp" data-results-exp="${esc(experiment.id)}">
        <div class="research-report-head">
          <h3>${esc(experiment.name)}</h3>
          ${localCopyControlsMarkup(experiment)}
        </div>
        ${localResultsTableMarkup(experiment)}
        <p class="research-queue-form-status" data-results-status="${esc(experiment.id)}" role="status"></p>
      </div>`).join('')
  }

  function renderExperimentModules() {
    renderDesigner()
    const persistenceError = experimentsSnapshot().persistenceError
    const status = moduleEl('designer').querySelector('[data-exp-form-status]')
    if (persistenceError && status) status.textContent = persistenceError
    renderRunBoard()
    renderResults()
    renderStatusPulse()
  }

  /* The run-board and results hosts are seeded in the module markup with a
     placeholder paragraph ("Nothing is running yet." / "No results have
     arrived yet."). When these renderers wrote host.innerHTML the seed was
     replaced along with everything else; once they took ownership of a child
     block instead, the seed was left standing between the bench block and
     the service block — so "No results have arrived yet." sat above 57 rows
     of results and "Nothing is running yet." above a run reading "running"
     (installed 1.0.14). The first renderer to claim a host removes the seed;
     each block speaks only for its own source from then on. */
  function claimHost(host, block) {
    for (const seed of Array.from(host.children)) {
      if (seed.matches('p.research-observed-empty')) seed.remove()
    }
    host.prepend(block)
  }

  /* The bench belongs to the selected project too. It used to ignore the
     selector entirely, so switching projects produced a page that blended
     two: the service board followed the new project while these cards still
     listed the old one's experiments (adversarial live review, 2026-08-15).
     Unfiled experiments belong to Unfiled and the All projects overview; they
     must never appear as another project's work. Excluded experiments remain
     reachable through the project selector. */
  function benchExperiments() {
    const all = experimentsSnapshot().experiments
    const shown = all.filter(experiment => filesUnder(selection, experiment.projectId))
    return { shown, hidden: all.length - shown.length }
  }

  function elsewhereNote(hidden) {
    if (hidden <= 0) return ''
    return `<p class="research-observed-empty">${hidden} experiment${hidden === 1 ? ' is' : 's are'} filed under another project. Choose it, or All projects, above.</p>`
  }

  /* The one designer form. Tier checkboxes build the reserved-meaning 'tier'
     axis for session runs; the axis rows add further axes; the runner select
     decides what the detail text IS. The Advanced text, when written, replaces
     the rows — a power user's exact object beats a builder's composition.
     Everything parses through the grid engine before buildExperiment sees it. */

  function designerAxisRows(form) {
    return [...form.querySelectorAll('[data-axis-row]')].map(row => ({
      name: row.querySelector('[data-axis-name]')?.value ?? '',
      values: row.querySelector('[data-axis-values]')?.value ?? '',
    }))
  }

  function designerColumnRows(form) {
    return [...form.querySelectorAll('[data-col-row]')].map(row => ({
      name: row.querySelector('[data-col-name]')?.value ?? '',
      kind: row.querySelector('[data-col-kind]')?.value ?? 'string',
      required: row.querySelector('[data-col-required]')?.checked === true,
    }))
  }

  function designerExtraAxes(form) {
    const advanced = form.elements.moreAxes.value.trim()
    if (advanced) {
      let extra
      try { extra = JSON.parse(advanced) }
      catch { return { ok: false, sentence: 'The extra axes did not read as an object. Write them like {"prompt_style": ["terse", "full"]}.' } }
      if (!extra || typeof extra !== 'object' || Array.isArray(extra)) {
        return { ok: false, sentence: 'The extra axes did not read as an object. Write them like {"prompt_style": ["terse", "full"]}.' }
      }
      if (Object.hasOwn(extra, 'tier')) {
        return { ok: false, sentence: 'Tier values come from the checkboxes above — take "tier" out of the axes text.' }
      }
      return { ok: true, axesRaw: extra }
    }
    const composed = axisRowsToObject(designerAxisRows(form))
    if (!composed.ok) return composed
    if (Object.hasOwn(composed.axesRaw, 'tier')) {
      return { ok: false, sentence: 'Tier values come from the checkboxes above — remove the axis row named tier.' }
    }
    return composed
  }

  function designerResultColumns(form) {
    const advanced = form.elements.resultColumns.value.trim()
    if (advanced) {
      try { return { ok: true, schemaRaw: JSON.parse(advanced) } }
      catch { return { ok: false, sentence: 'The result columns did not read as an object.' } }
    }
    return columnRowsToSchema(designerColumnRows(form))
  }

  /* The whole grid the form currently declares, tier axis included, shared by
     the live preview and the submit handler so the two can never disagree. */
  function designerGrid(form) {
    const extra = designerExtraAxes(form)
    if (!extra.ok) return extra
    const checkedTiers = [...form.querySelectorAll('input[name="tier"]:checked')].map(input => input.value)
    const kind = form.elements.runnerKind.value
    const axesRaw = kind === 'agent' && checkedTiers.length > 0 ? { tier: checkedTiers, ...extra.axesRaw } : extra.axesRaw
    if (Object.keys(axesRaw).length === 0) {
      return { ok: false, sentence: kind === 'agent' ? 'Pick at least one model tier to run on.' : 'Add at least one axis row so the grid has something to vary.' }
    }
    return { ok: true, axesRaw }
  }

  /* The living answer under the builder: what this grid will run, before Save
     is ever pressed. A refusal renders its sentence here instead, while the
     field that caused it is still under the person's hands. */
  function updateDesignerPreview(form) {
    const preview = form.querySelector('[data-exp-preview]')
    if (!preview) return
    const grid = designerGrid(form)
    if (!grid.ok) {
      preview.innerHTML = `<p class="research-queue-form-status">${esc(grid.sentence)}</p>`
      return
    }
    const model = gridRunPreview(grid.axesRaw, { replicates: Number(form.elements.runsPerCell.value) || 1 })
    if (!model.ok) {
      preview.innerHTML = `<p class="research-queue-form-status">${esc(model.sentence)}</p>`
      return
    }
    preview.innerHTML = `
      <p class="research-designer-hint">This grid makes ${model.runCount} ${model.runCount === 1 ? 'run' : 'runs'}:</p>
      ${model.labels.map(label => `<span class="research-cell">${esc(label)}</span>`).join('')}
      ${model.more > 0 ? `<span class="research-designer-hint">and ${model.more} more</span>` : ''}`
  }

  /* One meaning at a time: the detail area's label and placeholder follow the
     runner choice. Only those two attributes re-render; the field keeps its
     name, its text, and the submit handler that reads it. */
  function syncRunnerDetail(form) {
    const copy = RUNNER_DETAIL_COPY[form.elements.runnerKind.value] || RUNNER_DETAIL_COPY.agent
    const label = form.querySelector('[data-runner-detail-label]')
    if (label) label.textContent = copy
    form.elements.runnerDetail.placeholder = copy
    const pins = form.querySelector('[data-pinned-inputs]')
    if (pins) {
      // Do not hide or discard incompatible pins on a kind change: the user
      // must be able to see and remove them, and Save refuses until then.
      pins.hidden = form.elements.runnerKind.value !== 'process' && !form.querySelector('[data-pin-row]')
      pins.querySelector('[data-pin-add]').disabled = form.elements.runnerKind.value !== 'process'
    }
  }

  function parseDesignerForm(form) {
    const grid = designerGrid(form)
    if (!grid.ok) return grid
    const kind = form.elements.runnerKind.value
    const detail = form.elements.runnerDetail.value
    const axes = parseAxes(grid.axesRaw)
    if (!axes.ok) return axes
    const runner = parseDesignerRunner({ kind, detail,
      pinnedRows: [...form.querySelectorAll('[data-pin-row]')].map(row => ({ path: row.querySelector('[data-pin-path]').value, sha256: row.querySelector('[data-pin-sha256]').value })),
      optionsText: form.elements.runnerOptions.value, optionsKind: form.dataset.runnerOptionsKind,
      originalRunner: designerOriginalRunners.get(form),
    })
    if (!runner.ok) return runner
    const columns = designerResultColumns(form)
    if (!columns.ok) return columns
    const resultSchema = parseResultSchema(columns.schemaRaw)
    if (!resultSchema.ok) return resultSchema
    let agentSetup
    if (form.elements.agentSetupEnabled?.checked) {
      let files = []
      try { files = form.elements.agentSetupFiles.value.trim() ? JSON.parse(form.elements.agentSetupFiles.value) : [] }
      catch { return { ok: false, sentence: 'Clean-room files must be valid JSON.' } }
      const parsedSetup = parseResearchAgentSetup({ mode: 'clean-room', access: form.elements.agentSetupAccess.value, files })
      if (!parsedSetup.ok) return parsedSetup
      agentSetup = parsedSetup.agentSetup
    }
    return {
      ok: true,
      name: form.elements.name.value,
      axes: axes.axes,
      runner: runner.runner,
      resultSchema: resultSchema.resultSchema,
      runsPerCell: Number(form.elements.runsPerCell.value),
      datasetPath: form.elements.datasetPath.value,
      ...(agentSetup ? { agentSetup } : {}),
    }
  }

  /* THE EXAMPLE NEVER WRITES. The mock face renders the real designer — the
     form, the preview, the templates all run locally and demonstrate the
     surface — but the three presses that would persist or start something
     (Save, the run control, Remove) refuse with this sentence instead. The
     example toggle can be on while a real account and a real engine sit right
     behind the page, so "the save would fail anyway" is not a guard at all:
     without this gate a press against example data would write example data
     into a person's own account row, or start real workers from an invented
     spec. */
  const EXAMPLE_WRITE_REFUSAL = 'This is the example — it never saves, starts, or removes anything.'

  moduleEl('designer').addEventListener('submit', async event => {
    if (!event.target?.hasAttribute?.('data-exp-form')) return
    event.preventDefault()
    const form = event.target
    const status = form.querySelector('[data-exp-form-status]')
    if (source === 'mock') { if (status) status.textContent = EXAMPLE_WRITE_REFUSAL; return }
    const parsed = parseDesignerForm(form)
    if (!parsed.ok) { if (status) status.textContent = parsed.sentence; return }
    const epoch = bootEpoch, accountId = experimentsAccountId, contextProject = selection
    const projectId = selectedProject()?.projectId ?? null
    const isCurrent = () => !destroyed && epoch === bootEpoch && accountId === experimentsAccountId && contextProject === selection
    const saved = await commitExperimentChange(current => buildExperiment({
      name: parsed.name,
      axes: parsed.axes,
      runner: parsed.runner,
      resultSchema: parsed.resultSchema,
      runsPerCell: parsed.runsPerCell,
      datasetPath: parsed.datasetPath,
      ...(parsed.agentSetup ? { agentSetup: parsed.agentSetup } : {}),
      projectId,
    }, current), { persist: serialized => persistExperiments(serialized, accountId), isCurrent })
    if (!isCurrent()) return
    if (!saved.ok) { if (status) status.textContent = saved.sentence; return }
    renderExperimentModules()
  })

  moduleEl('designer').addEventListener('click', async event => {
    const runId = event.target?.dataset?.expRun
    const removeId = event.target?.dataset?.expRemove
    /* See EXAMPLE_WRITE_REFUSAL above: the refusal rides on the pressed button
       the same way every other refusal on this board does. Open, Duplicate and
       the templates stay live — they only read and prefill. */
    if (source === 'mock' && (runId || removeId)) {
      event.target.textContent = EXAMPLE_WRITE_REFUSAL
      return
    }
    if (runId) {
      const experiment = experimentsSnapshot().experiments.find(candidate => candidate.id === runId)
      if (!experiment) return
      const decision = decideDispatch(experiment, { projectId: selectedProject()?.projectId ?? experiment.projectId })
      if (!decision.ok) {
        event.target.textContent = decision.sentence
        return
      }
      event.target.disabled = true
      const contextEpoch = bootEpoch, contextProject = selection, contextAccountId = experimentsAccountId
      const isCurrent = () => !destroyed && contextEpoch === bootEpoch && contextProject === selection && contextAccountId === experimentsAccountId
      if (decision.mode === 'queue') {
        event.target.textContent = 'Submitting to the run queue…'
        const outcome = await submitExperimentRuns(runId, {
          persist: serialized => {
            if (!isCurrent()) return { ok: false }
            return persistExperiments(serialized, contextAccountId)
          },
          projectId: decision.projectId,
          isCurrent,
        })
        if (!isCurrent()) return
        if (!outcome.ok) {
          event.target.disabled = false
          event.target.textContent = outcome.sentence
          return
        }
        renderExperimentModules()
        /* A refused cell stays 'designed' and the first refusal sentence rides
           back on an ok-shaped outcome (submitExperimentRuns). Dropping it here
           made a settings-gate hold LOOK like a successful submit: the board
           re-rendered, nothing was queued, and no sentence said why. The
           designer's own status line says it, after the re-render that would
           otherwise wipe it. */
        /* Nothing queued and nothing refused means every cell was already
           submitted: the service replayed them by experiment and parameters.
           That is the idempotency working, but silence made the press look
           broken — a saved grid has no edit, so pressing it again is exactly
           what a person does (measured on the installed build, 2026-08-15). */
        /* The count comes from the cells, not from `replayed`: a cell that was
           already sent is skipped before the service is asked, so `replayed`
           stays 0 and the sentence used to carry no number at all (installed
           1.0.11). Say how many, and say what to press next. */
        const alreadySent = outcome.total - outcome.submitted - outcome.replayed
        const said = outcome.sentence || (outcome.submitted === 0
          ? (outcome.replayed > 0
            ? `Already queued — the run service recognised all ${outcome.replayed} of these runs and made no duplicates. Duplicate this experiment to run a fresh set.`
            : `Already sent — all ${alreadySent} cells of this experiment are with the run service. Press Duplicate to run a fresh set.`)
          : null)
        if (said) { const holdStatus = moduleEl('designer').querySelector('[data-exp-form-status]'); if (holdStatus) holdStatus.textContent = said }
        refreshServiceSnapshot()
        return
      }
      event.target.textContent = 'Starting the workers…'
      const outcome = await dispatchExperiment(runId, {
        agent: typeof window === 'undefined' ? null : window.mcAgent,
        persist: serialized => persistExperiments(serialized, contextAccountId),
        startAgent: startAgentForNode,
        isCurrent,
      })
      if (!isCurrent()) return
      if (!outcome.ok) {
        event.target.disabled = false
        event.target.textContent = outcome.sentence
        return
      }
      renderExperimentModules()
      return
    }
    if (removeId) {
      /* Removal is destructive and the stage-tidy drive (2026-08-15) measured
         it firing on a single press. Arm on the first press, act on the
         second; a lone press disarms itself so the label never lies. */
      const button = event.target
      if (button.dataset.armed !== 'true') {
        button.dataset.armed = 'true'
        button.textContent = 'Press again to remove'
        setTimeout(() => {
          if (button.isConnected && button.dataset.armed === 'true') {
            delete button.dataset.armed
            button.textContent = 'Remove'
          }
        }, 4000)
        return
      }
      const epoch = bootEpoch, accountId = experimentsAccountId
      const isCurrent = () => !destroyed && epoch === bootEpoch && accountId === experimentsAccountId
      const saved = await commitExperimentChange(current => removeExperiment(current, removeId), {
        persist: serialized => persistExperiments(serialized, accountId), isCurrent,
      })
      if (!isCurrent()) return
      if (!saved.ok) { event.target.textContent = saved.sentence; return }
      renderExperimentModules()
    }
  })

  /* Builder rows come and go in place — only the preview re-renders, so a
     half-typed field never loses its focus to a repaint. */
  moduleEl('designer').addEventListener('click', event => {
    const form = event.target?.closest?.('[data-exp-form]')
    if (!form) return
    if (event.target.hasAttribute('data-axis-add')) {
      form.querySelector('[data-axis-rows]').insertAdjacentHTML('beforeend', axisRowMarkup())
      form.querySelector('[data-axis-rows] [data-axis-row]:last-child [data-axis-name]')?.focus()
      updateDesignerPreview(form)
      return
    }
    if (event.target.hasAttribute('data-axis-remove')) {
      event.target.closest('[data-axis-row]')?.remove()
      updateDesignerPreview(form)
      return
    }
    if (event.target.hasAttribute('data-col-add')) {
      form.querySelector('[data-col-rows]').insertAdjacentHTML('beforeend', columnRowMarkup())
      form.querySelector('[data-col-rows] [data-col-row]:last-child [data-col-name]')?.focus()
      return
    }
    if (event.target.hasAttribute('data-col-remove')) {
      event.target.closest('[data-col-row]')?.remove()
    }
  })

  /* Gathering, duplicating, and the starter examples. The card's title and
     its Open control both toggle the same panel; Duplicate and the templates
     only prefill the one form and leave the saving to the person. */
  moduleEl('designer').addEventListener('click', event => {
    if (event.target?.hasAttribute?.('data-exp-import')) {
      moduleEl('designer').querySelector('[data-exp-import-file]')?.click()
      return
    }
    if (event.target?.hasAttribute?.('data-exp-export')) {
      const form = moduleEl('designer').querySelector('[data-exp-form]')
      const status = form?.querySelector('[data-exp-form-status]')
      if (!form) return
      const parsed = parseDesignerForm(form)
      if (!parsed.ok) { if (status) status.textContent = parsed.sentence; return }
      const { ok, ...spec } = parsed
      const exported = serializeExperimentImport(spec)
      if (!exported.ok) { if (status) status.textContent = exported.sentence; return }
      const link = document.createElement('a')
      link.href = URL.createObjectURL(new Blob([exported.text], { type: 'application/json' }))
      link.download = 'toolsenabled-research-experiment.json'
      try {
        link.click()
        if (status) status.textContent = 'Editable experiment downloaded. Nothing was saved or started.'
      } finally { URL.revokeObjectURL(link.href) }
      return
    }
    const openId = event.target?.dataset?.expOpen
    if (openId) { toggleGathered(openId); return }
    const closeId = event.target?.dataset?.expClose
    if (closeId) { gatheredExperimentId = null; renderDesigner(); return }
    const title = event.target?.closest?.('li[data-research-experiment] h3')
    if (title && !event.target.closest('[data-exp-gathered]')) {
      toggleGathered(title.closest('li[data-research-experiment]').dataset.researchExperiment)
      return
    }
    const duplicateId = event.target?.dataset?.expDuplicate
    if (duplicateId) {
      const experiment = experimentsSnapshot().experiments.find(candidate => candidate.id === duplicateId)
      const form = moduleEl('designer').querySelector('[data-exp-form]')
      if (experiment && form) prefillDesigner(form, duplicateSpec(experiment))
      return
    }
    const templateId = event.target?.dataset?.expTemplate
    if (templateId && DESIGNER_TEMPLATES[templateId]) {
      const form = moduleEl('designer').querySelector('[data-exp-form]')
      if (form) prefillDesigner(form, DESIGNER_TEMPLATES[templateId])
    }
  })

  moduleEl('designer').addEventListener('change', async event => {
    const input = event.target
    if (!input?.hasAttribute?.('data-exp-import-file')) return
    const revision = ++experimentImportRevision
    const form = moduleEl('designer').querySelector('[data-exp-form]')
    const status = form?.querySelector('[data-exp-form-status]')
    const file = input.files?.[0]
    const epoch = bootEpoch
    const accountId = experimentsAccountId
    const contextProject = selection
    const isCurrent = () => !destroyed && revision === experimentImportRevision
      && epoch === bootEpoch && accountId === experimentsAccountId && contextProject === selection
      && form && moduleEl('designer').querySelector('[data-exp-form]') === form
    input.value = ''
    if (!file || !form) return
    if (Number.isFinite(file.size) && file.size > 60000) {
      if (status) status.textContent = 'Experiment files must be 60000 bytes or smaller.'
      return
    }
    try {
      const imported = parseExperimentImport(await file.text())
      if (!isCurrent()) return
      if (!imported.ok) {
        if (status) status.textContent = imported.sentence
        return
      }
      const draft = duplicateSpec(imported.spec)
      draft.sentence = 'Imported as a draft. Review it, then save the experiment.'
      prefillDesigner(form, draft)
    } catch (error) {
      if (isCurrent() && status) status.textContent = 'The experiment file could not be read: ' + (error?.message || error)
    }
  })

  moduleEl('designer').addEventListener('input', event => {
    const form = event.target?.closest?.('[data-exp-form]')
    if (form && event.target.name === 'runnerOptions') form.dataset.runnerOptionsKind = form.elements.runnerKind.value
    if (form) { experimentImportRevision++; updateDesignerPreview(form) }
  })

  moduleEl('designer').addEventListener('click', event => {
    const form = event.target?.closest?.('[data-exp-form]')
    if (!form) return
    if (event.target?.hasAttribute('data-pin-add') && form.elements.runnerKind.value === 'process') {
      if (form.querySelectorAll('[data-pin-row]').length >= 32) {
        form.querySelector('[data-exp-form-status]').textContent = 'At most 32 inputs can be pinned.'
        return
      }
      form.querySelector('[data-pin-rows]').insertAdjacentHTML('beforeend', pinnedInputRowMarkup())
    }
    if (event.target?.hasAttribute('data-pin-remove')) event.target.closest('[data-pin-row]')?.remove()
    syncRunnerDetail(form)
  })

  moduleEl('designer').addEventListener('change', event => {
    const form = event.target?.closest?.('[data-exp-form]')
    if (!form) return
    experimentImportRevision++
    if (event.target.name === 'runnerKind') syncRunnerDetail(form)
    updateDesignerPreview(form)
  })

  /* One copy handler for the local tables wherever they render — the results
     module and the gathered panel both carry the same controls, and the
     status line found is the one beside the button that was pressed. */
  const onLocalCopyClick = async event => {
    const csvId = event.target?.dataset?.resultsCsv
    const jsonId = event.target?.dataset?.resultsJson
    if (!csvId && !jsonId) return
    const id = csvId || jsonId
    const experiment = experimentsSnapshot().experiments.find(candidate => candidate.id === id)
    if (!experiment) return
    const status = event.target.closest('.research-results-exp')?.querySelector(`[data-results-status="${id}"]`)
      || moduleEl('results').querySelector(`[data-results-status="${id}"]`)
    try {
      await navigator.clipboard.writeText(experimentExport(experiment, csvId ? 'csv' : 'json'))
      if (status) status.textContent = 'Copied. Paste it where you need it.'
    } catch {
      if (status) status.textContent = 'Select the table and copy it by hand — the clipboard refused this copy.'
    }
  }
  moduleEl('results').addEventListener('click', onLocalCopyClick)
  moduleEl('designer').addEventListener('click', onLocalCopyClick)

  const onExperimentsChanged = () => { if (!destroyed) renderExperimentModules() }
  window.addEventListener(RESEARCH_EXPERIMENTS_EVENT, onExperimentsChanged)

  /* ---------- the local tiers panel ----------
     Read from the bridge's GET route — the same reading the engine's own MCP
     tool serves. Reason codes are machine identifiers; they render with their
     underscores turned to spaces rather than being hidden, because "another
     local model is resident" is exactly what a researcher needs to know. */

  function tierRowMarkup(word, tier) {
    if (!tier || typeof tier !== 'object') return ''
    const state = tier.enabled !== true
      ? 'switched off in settings'
      : tier.ready === true
        ? 'ready'
        : `not ready · ${esc(String(tier.reason || 'the app was not told why').replace(/_/g, ' '))}`
    return `
      <div class="research-register-row">
        <h3>${esc(word)}</h3>
        <div><p>${esc(tier.model || 'The model name was not reported.')} — ${state}</p></div>
      </div>`
  }

  function renderTiers(result) {
    const host = moduleEl('tiers').querySelector('[data-research-tiers]')
    if (!host) return
    if (!result?.ok || !result.receipt) {
      /* The refusal CODE is the useful half — the message is a scrubbed
         generic by design. MODEL_NO_GPU_PEER_CONFIGURED, rendered in words,
         tells a single-machine researcher exactly what is going on. */
      const reason = result?.code === 'MODEL_NO_GPU_PEER_CONFIGURED'
        ? 'no local model host is set up on the computer you are driving yet'
        : typeof result?.code === 'string' && result.code.length > 0
          ? result.code.toLowerCase().replace(/_/g, ' ')
          : result?.reason
      host.innerHTML = unavailableMarkup('The local tiers', reason)
      return
    }
    const receipt = result.receipt
    /* NOT-THERE, ANSWERED RATHER THAN THROWN. The engine used to raise
       MODEL_NO_GPU_PEER_CONFIGURED for an installation that declares no peer
       machine, so this arrived above as a refusal and every poll was written to
       the durable ledger as a tool failure; engine research-strong.js status()
       now returns the same fact as a reading. The person's situation is
       identical, so the sentence is too — and the measurement row below is
       skipped rather than printed as zeroes, because nothing was measured. */
    if (receipt.available === false) {
      host.innerHTML = unavailableMarkup('The local tiers', receipt.reason === 'gpu_peer_ambiguous'
        ? 'more than one GPU machine is configured and none is marked as the one to use'
        : 'no local model host is set up on the computer you are driving yet')
      return
    }
    const facts = [
      Number.isSafeInteger(receipt.freeRamMiB) ? `${Math.round(receipt.freeRamMiB / 1024)} GB RAM free` : null,
      Number.isSafeInteger(receipt.freeVramMiB) ? `${Math.round(receipt.freeVramMiB / 1024)} GB VRAM free` : null,
      Number.isFinite(receipt.gpuTemperatureC) ? `GPU ${receipt.gpuTemperatureC}°C` : null,
      receipt.onBattery === true ? 'on battery — heavy runs pause' : null,
    ].filter(Boolean).join(' · ')
    host.innerHTML = `
      ${facts ? `<p class="research-observed-empty">${esc(facts)}</p>` : ''}
      ${tierRowMarkup('Fast', receipt.fast)}
      ${tierRowMarkup('Strong', receipt.strong)}`
  }

  /* ---------- the project layer ----------
     Projects, durable grid experiments, queued runs, results and session
     assignment all live behind the action bridge; this block renders what the
     service answered and never invents an empty list from a refusal. The
     selection (which project this page looks at) is the one local remembering. */

  const assignmentStore = createAssignmentStore({ storage: typeof window === 'undefined' ? null : window.localStorage })
  let assignmentReadError = null
  let selection = readProjectSelection(typeof window === 'undefined' ? null : window.localStorage)
  let service = null            // the last readResearchSnapshot result, ok or not
  const runsByExperiment = new Map()   // experimentId -> readRuns result
  const resultsByRun = new Map()       // runId -> result-read envelope, including refusals
  let runPollTimer = null

  const serviceCharts = new Map()   // experimentId -> { resize, destroy }
  const projectBar = bar.querySelector('[data-project-bar]')
  const projectSelect = projectBar.querySelector('[data-project-select]')
  const projectNewBtn = projectBar.querySelector('[data-project-new]')
  const projectStatus = projectBar.querySelector('[data-project-status]')
  let activeProjectIds = new Set()
  const projectActivity = createResearchProjectActivity({
    onChange(ids) {
      activeProjectIds = ids
      if (destroyed || !service?.ok) return
      const byId = new Map(service.projects.map(project => [project.projectId, project]))
      for (const option of projectSelect.querySelectorAll('option')) {
        const project = byId.get(option.getAttribute('value'))
        if (project) option.textContent = projectOptionLabel(project)
      }
    },
  })
  function projectOptionLabel(project) {
    return `${project.name}${project.enabled === false ? ' (switched off)' : ''}${activeProjectIds.has(project.projectId) ? ' — active' : ''}`
  }

  function selectedProject() {
    if (!service?.ok) return null
    return service.projects.find(project => project.projectId === selection) || null
  }

  /* A REMEMBERED PROJECT THAT NO LONGER EXISTS MADE THE PAGE LOOK EMPTIED.
   *
   * The selection is remembered locally; the project list comes from the
   * service. Nothing reconciled the two. When the remembered id was not in the
   * returned list -- the project was deleted, or opened on another machine --
   * renderProjectBar marked NO option `selected`, so the browser fell back to
   * the first one and the picker read "All projects". Meanwhile `selection`
   * still held the dead id and every filter on this page went on filtering by
   * it. So the control said all, the page showed none, and the person's
   * reasonable conclusion was that their experiments were gone.
   *
   * Reconciled HERE, where the snapshot lands, rather than in renderProjectBar:
   * the run board, the results, the pulse and the designer cards all read
   * `selection` directly, and several of them render before the bar does. Fixing
   * it at the display layer would have left the filters disagreeing with the
   * control for one paint -- the same defect, harder to see.
   *
   * IT DOES NOT PERSIST, AND THAT IS THE CAREFUL PART. Writing the fallback back
   * to storage would mean one well-formed empty snapshot -- a service that
   * momentarily answers with zero projects -- permanently erasing a choice the
   * person made. So this corrects what the page DOES this session and leaves
   * what it REMEMBERS alone; if the projects come back, so does the selection.
   * PROJECT_ALL and PROJECT_UNFILED are never reconciled away: neither names a
   * project, so neither can go stale. */
  function reconcileSelection() {
    if (!service?.ok || !Array.isArray(service.projects)) return
    if (selection === PROJECT_ALL || selection === PROJECT_UNFILED) return
    if (service.projects.some(project => project.projectId === selection)) return
    selection = PROJECT_ALL
  }

  // The "next step" strip (Explore an example design… / Choose project / Open
  // designer / Inspect runs / Read evidence) described the older page; the
  // areas above are the navigation now (owner, 2026-09-21).
  function renderProjectBar() {
    benchmarkBuilder.setContext(selection, source)
    if (!service) {
      // The example face states its own reason above; a live face with no
      // snapshot yet is still reading, and says so rather than sitting blank.
      if (source !== 'mock') projectStatus.textContent = 'Reading your projects…'
      return
    }
    if (!service.ok) {
      projectSelect.disabled = true
      projectNewBtn.hidden = true
      projectStatus.textContent = `Projects could not be read — ${service.reason || 'the research service did not answer'}.`
      return
    }
    const options = [
      `<option value="${PROJECT_ALL}"${selection === PROJECT_ALL ? ' selected' : ''}>All projects</option>`,
      ...service.projects.map(project => `
        <option value="${esc(project.projectId)}"${selection === project.projectId ? ' selected' : ''}>${esc(projectOptionLabel(project))}</option>`),
      `<option value="${PROJECT_UNFILED}"${selection === PROJECT_UNFILED ? ' selected' : ''}>Unfiled</option>`,
    ]
    projectSelect.innerHTML = options.join('')
    projectSelect.disabled = false
    projectNewBtn.hidden = false
    if (service.settings && service.settings.pipelineEnabled === false) {
      /* THE SENTENCE NOW POINTS AT A SWITCH THAT EXISTS.
         It said "switched off in settings" for months while Settings carried no
         such switch anywhere -- the row and the refusal were real and the
         control had never been built, so the only way to run anything was to
         edit a file beside the program. The switch is in Settings under
         Research now (src/research-settings.js), and this is a link straight to
         it rather than an instruction to go looking: the row it means opens the
         section it lives in and scrolls to itself. Text and link are set
         separately because the reason a person is reading this can contain a
         path and must never be built into markup. */
      projectStatus.textContent = 'The research pipeline is switched off in settings; queued runs wait until it is on. '
      const link = document.createElement('a')
      link.className = 'host-absent-action'
      link.href = pipelineSettingHref()
      link.textContent = 'Open that switch'
      projectStatus.append(link)
    } else {
      projectStatus.textContent = ''
    }
  }

  projectSelect.addEventListener('change', () => {
    selection = projectSelect.value
    benchmarkBuilder.setContext(selection, source)
    writeProjectSelection(typeof window === 'undefined' ? null : window.localStorage, selection)
    /* Every module that filters by project must re-render together. The
       adversarial live review switched projects and got a blended page: the
       service board, results and pulse followed the new project while the
       designer cards and the run board still listed the OTHER project's
       experiments. A gathered panel belonging to the project just left is
       closed rather than carried across. */
    if (gatheredExperimentId) {
      const stillHere = experimentsSnapshot().experiments
        .find(experiment => experiment.id === gatheredExperimentId && filesUnder(selection, experiment.projectId))
      if (!stillHere) gatheredExperimentId = null
    }
    renderExperimentModules()
    renderServiceModules()
    refreshFindings()
  })

  /* An inline name field, not window.prompt: Electron throws on prompt(), so
     the packaged app's New-project click died in the handler — the walkthrough
     harness caught it because a human's click path is exactly what it drives. */
  const projectNewForm = el(`
    <span class="research-project-new" data-project-new-form hidden>
      <input type="text" maxlength="120" placeholder="Name the new project." aria-label="New project name" data-project-new-name/>
      <button type="button" data-project-new-save>Create</button>
      <button type="button" data-project-new-cancel>Cancel</button>
    </span>`)
  projectNewBtn.after(projectNewForm)
  const projectNewName = projectNewForm.querySelector('[data-project-new-name]')

  function setProjectFormOpen(open) {
    const heldFocus = !open && projectNewForm.contains(document.activeElement)
    projectNewForm.hidden = !open
    projectNewBtn.hidden = open || !service?.ok
    if (open) projectNewName.focus()
    else if (heldFocus) restoreProjectFormFocus(projectNewForm, projectNewBtn)
  }

  projectNewBtn.addEventListener('click', () => setProjectFormOpen(true))
  projectNewForm.querySelector('[data-project-new-cancel]').addEventListener('click', () => setProjectFormOpen(false))

  let projectSavePending = false
  async function createProjectFromForm() {
    if (projectSavePending || destroyed) return
    const name = projectNewName.value
    if (typeof name !== 'string' || name.trim().length === 0) {
      projectStatus.textContent = 'Name the project first.'
      return
    }
    const saveBtn = projectNewForm.querySelector('[data-project-new-save]')
    projectSavePending = true
    saveBtn.disabled = true
    let saved
    try {
      saved = await saveProject({ name: name.trim(), enabled: true })
    } finally {
      projectSavePending = false
      saveBtn.disabled = false
    }
    if (destroyed) return
    if (!saved.ok) {
      projectStatus.textContent = `The project was not created — ${saved.reason || 'the research service did not say why'}. Nothing was saved; try once more.`
      return
    }
    projectNewName.value = ''
    setProjectFormOpen(false)
    selection = saved.project.projectId
    writeProjectSelection(typeof window === 'undefined' ? null : window.localStorage, selection)
    await refreshServiceSnapshot()
  }

  projectNewForm.querySelector('[data-project-new-save]').addEventListener('click', createProjectFromForm)
  projectNewName.addEventListener('keydown', event => { if (event.key === 'Enter') createProjectFromForm() })

  function allServiceExperiments() {
    if (!service?.ok) return []
    return Object.entries(service.experiments).flatMap(([projectId, experiments]) =>
      experiments.map(experiment => ({ ...experiment, projectId })))
  }

  function serviceExperiments() {
    return allServiceExperiments().filter(experiment => filesUnder(selection, experiment.projectId))
  }

  function renderSessionsModule() {
    const host = moduleEl('sessions').querySelector('[data-research-sessions]')
    if (!host) return
    /* THE ONE MODULE THAT KEEPS A SENTENCE ON THE EXAMPLE FACE, and the call
       was made by reading what the surface needs: every row here is a claim
       about the person's machine — the service's project names, the assignment
       store's rows, the live-session registry. Inventing an example assignment
       would put "Every session on this computer" (the assign-all rule's own
       words) on screen as sample data, which reads as an operational claim no
       matter how the mast is badged. So the module settles honestly instead of
       sitting on "Reading…" for ever, and the sentence says what would appear
       here rather than pointing at a dead settings toggle. */
    if (source === 'mock') {
      host.innerHTML = '<p class="research-observed-empty">In the example, no sessions are filed yet. With your own data, sessions you assign to a project from the computers page appear here.</p>'
      return
    }
    if (!service) return
    let assignments
    try { assignments = assignmentStore.snapshot() }
    catch (error) {
      host.innerHTML = unavailableMarkup('The session assignments', error.message)
      return
    }
    const removals = assignments.removals.filter(row => filesUnder(selection, row.projectId))
    const legacyMarkup = assignments.unboundLegacy
      ? '<p class="research-authorization">Older assignment changes have no saved computer identity. They remain saved and will not be retried on this computer.</p>' : ''
    const pendingMarkup = legacyMarkup + (removals.length
      ? `<p class="research-authorization" data-session-removals-pending>${removals.length} removal${removals.length === 1 ? ' is' : 's are'} saved in this browser; the research service has not confirmed ${removals.length === 1 ? 'it' : 'them'} yet. This browser will retry when the service is available.</p>`
      : '')
    if (assignmentReadError) {
      host.innerHTML = unavailableMarkup('The session assignments', assignmentReadError) + pendingMarkup
      return
    }
    if (!service.ok) {
      host.innerHTML = unavailableMarkup('The session assignments', service.reason) + pendingMarkup
      return
    }
    const rows = assignments.rows.filter(row => filesUnder(selection, row.projectId))
    const projectName = id => service.projects.find(project => project.projectId === id)?.name || id
    if (rows.length === 0) {
      host.innerHTML = pendingMarkup || '<p class="research-observed-empty">No sessions are filed under this view. File one from the computers page, or assign every session with the all rule there.</p>'
      return
    }
    const live = readLiveSession()
    host.innerHTML = `${pendingMarkup}
      <ol class="research-catalog" data-research-session-list>
        ${rows.map(row => `
          <li class="research-report">
            <div class="research-report-body">
              <div class="research-report-head">
                <h3>${esc(row.kind === 'all' ? 'Every session on the computer you are driving' : `${row.kind} · ${row.ref}`)}${live && row.kind === 'observed' && live.sessionId === row.ref ? ' <span class="research-observed-empty">— live now</span>' : ''}</h3>
                <dl class="research-report-meta"><div><dt>project</dt><dd>${esc(projectName(row.projectId))}</dd></div></dl>
              </div>
              ${row.pending ? '<p class="research-authorization">Saved in this browser; the research service has not heard it yet.</p>' : ''}
              <div class="research-queue-controls">
                <button type="button" data-session-unassign data-project="${esc(row.projectId)}" data-kind="${esc(row.kind)}" data-ref="${esc(row.ref)}" data-assignment-id="${esc(row.assignmentId)}">Unassign</button>
                <a class="host-absent-action" href="#/computers">Open the computers page</a>
              </div>
            </div>
          </li>`).join('')}
      </ol>`
  }

  moduleEl('sessions').addEventListener('click', async event => {
    const button = event.target
    if (!button?.hasAttribute?.('data-session-unassign')) return
    button.disabled = true
    const result = await assignmentStore.unassign(button.dataset.project, button.dataset.kind, button.dataset.ref, button.dataset.assignmentId)
    if (destroyed || source === 'mock') return
    button.disabled = false
    if (!result.ok) { button.textContent = result.sentence; return }
    renderSessionsModule()
  })

  /* ---------- the service run board and results ---------- */

  async function refreshRuns() {
    const experiments = serviceExperiments()
    for (const experiment of experiments) {
      runsByExperiment.set(experiment.experimentId, await readRuns(experiment.experimentId))
    }
    /* Same in-flight rule as refreshServiceSnapshot: a verdict flip to 'mock'
       mid-read means these repaints belong to a world that no longer exists. */
    if (destroyed || source === 'mock') return
    /* The bench run board reads this same cache for its cells' live state, so
       it must repaint when the cache fills. Without this it painted once with
       a cold cache and stayed there: every cell read "queued", including a
       9/9-finished experiment, until an unrelated re-render happened to fix
       it (measured on the installed build, 2026-08-15 — and it is the first
       thing on screen). It renders the service board itself, so it comes
       first and there is no second call. */
    renderRunBoard()
    /* The bench results block decides whether to print "No results have
       arrived yet." by asking whether the SERVICE has results — from this
       same cache. Painted once cold, it said so above 57 finished rows and
       was never asked again (installed 1.0.15). Repaint it here too. */
    renderResults()
    renderServiceResults()
    const opened = experimentsSnapshot().experiments.find(candidate => candidate.id === gatheredExperimentId)
    if (opened?.serviceExperimentId) renderGatheredService(opened)
    renderStatusPulse()
    scheduleRunPoll()
  }

  function anyRunActive() {
    for (const read of runsByExperiment.values()) {
      if (read?.ok === true && read.runs.some(run => !runIsTerminal(run?.task?.status))) return true
    }
    return false
  }

  function scheduleRunPoll() {
    if (runPollTimer) { clearTimeout(runPollTimer); runPollTimer = null }
    /* Mock never polls: there is no service behind the example, and a timer
       left running would drag the live loaders back over the sample face. */
    if (destroyed || source === 'mock') return
    /* The poll refreshes runs; the LIFECYCLE comes from the snapshot, and
       without re-reading it the worker control keeps its old word. Measured
       on installed 1.0.11: seven minutes after the worker process died the
       control still read "Run worker: running." and offered only Stop, so
       there was no Start to press to recover.
       Polling only while RUNS are active was not enough: kill the worker
       while its queue is empty and nothing polls at all, so the control
       claimed "running" for six and a half minutes with no worker process
       alive (installed 1.0.12). While the service says a worker is running,
       keep checking — slower, because nothing is in flight. */
    const active = anyRunActive()
    const watchingWorker = Boolean(service?.ok && service.lifecycle?.running === true)
    if (!active && !watchingWorker) return
    runPollTimer = setTimeout(() => { refreshServiceSnapshot() }, active ? 5000 : 15000)
  }

  /* The worker control: the service's own lifecycle word beside a start/stop
     that reports the verified receipt state, never an assumed one. */
  function workerControlMarkup() {
    const lifecycle = service?.ok ? service.lifecycle : null
    if (!lifecycle) return ''
    const running = lifecycle.running === true
    const word = typeof lifecycle.status === 'string' ? lifecycle.status.replace(/_/g, ' ') : 'unknown'
    /* A cold start takes several seconds. The pending state lives HERE rather
       than only in the click handler because the run poll repaints this board
       while the request is in flight, which used to wipe the "Starting the
       worker." sentence and hand back an enabled button — seven seconds of
       apparent dead air, and an invitation to press twice (measured on the
       installed build, 2026-08-15). */
    if (workerPending) {
      const verb = workerPending === 'start' ? 'Starting' : 'Stopping'
      return `
        <div class="research-queue-controls" data-research-worker>
          <span class="research-observed-empty">Run worker: ${esc(word)}.</span>
          <button type="button" disabled data-research-worker-pending="${esc(workerPending)}">${verb} the worker…</button>
          <span class="research-queue-form-status" data-research-worker-status role="status">${verb} the worker. This can take a few seconds.</span>
        </div>`
    }
    return `
      <div class="research-queue-controls" data-research-worker>
        <span class="research-observed-empty">Run worker: ${esc(word)}.</span>
        ${lifecycle.available === false ? '' : `<button type="button" data-research-worker-toggle="${running ? 'stop' : 'start'}">${running ? 'Stop the worker' : 'Start the worker'}</button>`}
        <span class="research-queue-form-status" data-research-worker-status role="status"></span>
      </div>`
  }

  function runDrillMarkup(run) {
    return `
      <details class="research-run-drill" data-run-drill="${esc(run.runId)}">
        <summary>${esc(Object.values(run?.params || {}).join(' · ') || run.runId)} · ${esc(runTaskStateWord(run?.task))}</summary>
        <div class="research-run-drill-body" data-run-drill-body="${esc(run.runId)}">
          <p class="research-observed-empty">Open reads the run's progress and files.</p>
        </div>
      </details>`
  }

  function renderServiceRunBoard() {
    const host = moduleEl('runboard').querySelector('[data-research-runboard]')
    if (!host || !service) return
    let block = host.querySelector('[data-service-runboard]')
    if (!block) {
      block = el('<div data-service-runboard></div>')
      host.appendChild(block)
    }
    if (!service.ok) {
      block.innerHTML = unavailableMarkup('The queued runs', service.reason)
      return
    }
    const experiments = serviceExperiments()
    if (experiments.length === 0) {
      block.innerHTML = `${workerControlMarkup()}<p class="research-observed-empty">No grid experiments are registered under this view yet.</p>`
      return
    }
    block.innerHTML = workerControlMarkup() + experiments.map(experiment => {
      const read = runsByExperiment.get(experiment.experimentId)
      if (!read) return `<div class="research-runboard-exp"><h3>${esc(experiment.name)}</h3><p class="research-observed-empty">Reading its runs.</p></div>`
      if (read.ok !== true) return `<div class="research-runboard-exp"><h3>${esc(experiment.name)}</h3>${unavailableMarkup('Its run list', read.reason)}</div>`
      const rows = read.runs.map(run => runDrillMarkup(run)).join('')
      /* A duplicated card keeps its runner, and the service identifies an
         experiment by its configuration — so every Duplicate files its runs
         under the FIRST card's name. Forty runs appearing under one heading
         reads as a labelling bug unless the page says why (installed 1.0.12).
         It is one study with more runs; name the designs feeding it. */
      const designs = experimentsSnapshot().experiments
        .filter(bench => bench.serviceExperimentId === experiment.experimentId)
      const shared = designs.length > 1
        ? `<p class="research-observed-empty">${designs.length} designs on this bench file their runs here: ${esc(designs.map(design => design.name).join(', '))}.</p>`
        : ''
      return `
        <div class="research-runboard-exp" data-service-exp="${esc(experiment.experimentId)}">
          <h3>${esc(experiment.name)} <span class="research-observed-empty">(queued through the service)</span></h3>
          ${shared}
          <div class="research-runboard-cells">${rows || '<p class="research-observed-empty">No runs submitted yet.</p>'}</div>
        </div>`
    }).join('')
  }

  moduleEl('runboard').addEventListener('click', async event => {
    const action = event.target?.dataset?.researchWorkerToggle
    if (!action || workerPending) return
    workerPending = action
    renderServiceRunBoard()
    const key = globalThis.crypto?.randomUUID?.() || `worker-${Date.now()}`
    const result = await postBridgeAction('research-lifecycle', { action, idempotencyKey: key })
    workerPending = null
    if (result?.ok === true && result.receipt) {
      const receipt = result.receipt
      await refreshServiceSnapshot()
      const settled = moduleEl('runboard').querySelector('[data-research-worker-status]')
      if (settled) settled.textContent = `The service says: ${String(receipt.status || 'unknown').replace(/_/g, ' ')}.`
      return
    }
    renderServiceRunBoard()
    const status = moduleEl('runboard').querySelector('[data-research-worker-status]')
    if (status) {
      const reason = String(result?.reason || 'the research service did not answer').replace(/\.$/, '')
      status.textContent = `That did not happen — ${reason}. The worker is unchanged; try once more.`
    }
  })

  /* The drill: opening a run reads its checkpoint, files and results once,
     and renders absence as a sentence rather than an empty pane. The same
     handler serves the run board and the gathered panel's drill rows. */
  const onRunDrillToggle = async event => {
    const drill = event.target
    if (!drill?.hasAttribute?.('data-run-drill') || !drill.open) return
    const runId = drill.dataset.runDrill
    const body = drill.querySelector(`[data-run-drill-body="${runId}"]`)
    if (!body || body.dataset.loaded === 'true') return
    body.dataset.loaded = 'true'
    const [runRead, resultsRead] = await Promise.all([readRun(runId), readResults(runId)])
    if (runRead.ok !== true) {
      body.innerHTML = unavailableMarkup('This run', runRead.reason)
      body.dataset.loaded = ''
      return
    }
    const drillModel = runDrillModel({ run: runRead.run, results: resultsRead.ok === true ? resultsRead.results : [] })
    body.innerHTML = `
      <p>${esc(drillModel.checkpointSummary)}</p>
      <p class="research-observed-empty" data-research-evidence="${esc(drillModel.evidence.status)}">${esc(drillModel.evidence.sentence)}</p>
      <p class="research-observed-empty" data-research-input-checks="${esc(drillModel.inputChecks.status)}">${esc(drillModel.inputChecks.label)}: ${esc(drillModel.inputChecks.sentence)}</p>
      ${drillModel.inputReceiptText ? `<details><summary>Inspect the recorded command, environment fingerprint and file checks</summary><pre class="research-input-receipt">${esc(drillModel.inputReceiptText)}</pre></details>` : ''}
      ${drillModel.errorSentence ? `<p class="research-unavailable projection-unavailable">${esc(drillModel.errorSentence)}</p>` : ''}
      <p class="research-observed-empty">Settings: ${esc(Object.entries(drillModel.params).map(([name, value]) => `${name} ${value}`).join(', ') || 'none')}.${resultsRead.ok === true ? ` Results recorded: ${drillModel.resultCount}.` : ''}</p>
      ${resultsRead.ok !== true ? unavailableMarkup('Its result records', resultsRead.reason) : ''}
      <p class="research-observed-empty">${esc(drillModel.artifactsSentence)}</p>
      ${Array.isArray(drillModel.artifacts) && drillModel.artifacts.length ? `<ul class="research-run-drill-files">${drillModel.artifacts.map(file => `<li>${esc(file.name)}${Number.isSafeInteger(file.bytes) ? ` · ${formatBytes(file.bytes)}` : ''}</li>`).join('')}</ul>` : ''}
      ${drillModel.artifactDir ? `<p class="research-observed-empty">Folder: ${esc(drillModel.artifactDir)}</p>` : ''}`
    // A refused read is not an empty result set and must remain retryable.
    if (resultsRead.ok !== true) body.dataset.loaded = ''
  }
  moduleEl('runboard').addEventListener('toggle', onRunDrillToggle, true)
  moduleEl('designer').addEventListener('toggle', onRunDrillToggle, true)

  /* The service-side markup builders, shared by the results module and the
     gathered panel so the two can never drift apart. */

  function serviceCopyControlsMarkup(experimentId) {
    return `
            <div class="research-queue-controls">
              <button type="button" data-service-csv="${esc(experimentId)}">Copy as CSV</button>
              <button type="button" data-service-json="${esc(experimentId)}">Copy as JSON</button>
            </div>`
  }

  /* The claim form under a results table. It files the finding under the
     experiment's own project through the research service; the reply names
     the recorded finding, and a refusal keeps the claim in the field. */
  function findingFormMarkup(experimentId, projectId) {
    if (typeof projectId !== 'string' || projectId.length === 0) return ''
    return `
          <form class="research-queue-form research-finding-form" data-finding-form="${esc(experimentId)}" data-finding-project="${esc(projectId)}">
            <input name="claim" maxlength="500" placeholder="What did these results show? One sentence." aria-label="Finding claim"/>
            <div class="research-queue-form-row">
              <button type="submit">Save as finding</button>
              <span class="research-queue-form-status" data-finding-status role="status"></span>
            </div>
          </form>`
  }

  async function renderServiceResults() {
    const host = moduleEl('results').querySelector('[data-research-results]')
    if (!host || !service?.ok) return
    let block = host.querySelector('[data-service-results]')
    if (!block) {
      block = el('<div data-service-results></div>')
      host.appendChild(block)
    }
    const experiments = serviceExperiments()
    const sections = []
    for (const experiment of experiments) {
      const read = runsByExperiment.get(experiment.experimentId)
      if (read?.ok !== true) continue
      const doneRuns = read.runs.filter(run => runIsTerminal(run?.task?.status))
      for (const run of doneRuns) {
        if (!resultsByRun.has(run.runId) || resultsByRun.get(run.runId)?.ok === false || resultsByRun.get(run.runId)?.readVersion !== resultReadVersion(run)) {
          const results = await readResults(run.runId)
          resultsByRun.set(run.runId, { ...results, readVersion: resultReadVersion(run) })
        }
      }
      if (doneRuns.length === 0) continue
      const model = resultTableModel({ runs: doneRuns, resultsByRun, resultSchema: experiment.resultSchema })
      const column = chosenColumn(experiment.experimentId, model, experiment.resultSchema)
      const columns = chartableColumns(model, experiment.resultSchema)
      /* Same picker the gathered view carries: without it the results-module
         chart was unlabeled bars of one column with no way to switch, and a
         convergence study whose default column is `mean` reads as nine
         identical bars (installed 1.0.14). */
      const picker = column && columns.length > 1 ? `
          <label class="research-chart-pick">Chart:
            <select data-service-chart-column="${esc(experiment.experimentId)}">${columns.map(candidate => `
              <option value="${esc(candidate.name)}"${candidate.name === column.name ? ' selected' : ''}>${esc(candidate.label)}</option>`).join('')}
            </select>
          </label>` : ''
      sections.push(`
        <div class="research-results-exp" data-service-results-exp="${esc(experiment.experimentId)}">
          <div class="research-report-head">
            <h3>${esc(experiment.name)}</h3>
            ${serviceCopyControlsMarkup(experiment.experimentId)}
          </div>
          ${serviceResultsTableMarkup(model)}
          ${picker}
          <div class="research-result-chart" data-service-chart="${esc(experiment.experimentId)}" hidden></div>
          <p class="research-queue-form-status" data-service-results-status="${esc(experiment.experimentId)}" role="status"></p>
          ${findingFormMarkup(experiment.experimentId, experiment.projectId)}
        </div>`)
    }
    /* Destroy the old charts BEFORE the markup they live in is replaced. The
       reverse order still released echarts' registry, but disposed charts
       whose hosts were already detached — the exact ordering that turns into
       a leak the first time an early return lands between the two. */
    for (const chart of serviceCharts.values()) chart.destroy()
    serviceCharts.clear()
    block.innerHTML = sections.join('')
    /* The chart mounts only where a declared numeric column actually holds a
       number; otherwise its host stays hidden and no empty frame renders. */
    const mountServiceChart = (experiment, model, chosen) => {
      serviceCharts.get(experiment.experimentId)?.destroy()
      serviceCharts.delete(experiment.experimentId)
      const chartHost = block.querySelector(`[data-service-chart="${experiment.experimentId}"]`)
      if (!chosen || !chartHost) return
      chartHost.hidden = false
      const mounted = createResultChart(chartHost, { model, column: chosen })
      if (mounted) serviceCharts.set(experiment.experimentId, mounted)
      else chartHost.hidden = true
    }
    for (const experiment of experiments) {
      const read = runsByExperiment.get(experiment.experimentId)
      if (read?.ok !== true) continue
      const doneRuns = read.runs.filter(run => runIsTerminal(run?.task?.status))
      if (doneRuns.length === 0) continue
      const model = resultTableModel({ runs: doneRuns, resultsByRun, resultSchema: experiment.resultSchema })
      const columns = chartableColumns(model, experiment.resultSchema)
      mountServiceChart(experiment, model, chosenColumn(experiment.experimentId, model, experiment.resultSchema))
      block.querySelector(`[data-service-chart-column="${experiment.experimentId}"]`)?.addEventListener('change', event => {
        chartChoice.set(experiment.experimentId, event.target.value)
        mountServiceChart(experiment, model, columns.find(candidate => candidate.name === event.target.value) || null)
      })
    }
  }

  /* One copy handler for the service tables wherever they render — the
     results module and the gathered panel carry the same controls. The
     experiment is looked up across every project, because a gathered panel
     can stay open while the selector looks somewhere else. */
  const onServiceCopyClick = async event => {
    const csvId = event.target?.dataset?.serviceCsv
    const jsonId = event.target?.dataset?.serviceJson
    if (!csvId && !jsonId) return
    const experimentId = csvId || jsonId
    const experiment = allServiceExperiments().find(candidate => candidate.experimentId === experimentId)
    const read = runsByExperiment.get(experimentId)
    if (!experiment || read?.ok !== true) return
    const doneRuns = read.runs.filter(run => runIsTerminal(run?.task?.status))
    const model = resultTableModel({ runs: doneRuns, resultsByRun, resultSchema: experiment.resultSchema })
    const status = event.target.closest('.research-results-exp')?.querySelector(`[data-service-results-status="${experimentId}"]`)
      || moduleEl('results').querySelector(`[data-service-results-status="${experimentId}"]`)
    try {
      await navigator.clipboard.writeText(resultsExport(model, csvId ? 'csv' : 'json'))
      if (status) status.textContent = 'Copied. Paste it where you need it.'
    } catch {
      if (status) status.textContent = 'Select the table and copy it by hand — the clipboard refused this copy.'
    }
  }
  moduleEl('results').addEventListener('click', onServiceCopyClick)
  moduleEl('designer').addEventListener('click', onServiceCopyClick)

  /* Save as finding: the claim posts through the findings client with the
     open status, and the reply names the recorded finding. A refusal keeps
     the claim in the field so nothing typed is lost. */
  const pendingFindingForms = new WeakSet()
  const onFindingSubmit = async event => {
    if (!event.target?.hasAttribute?.('data-finding-form')) return
    event.preventDefault()
    const form = event.target
    if (destroyed || source === 'mock' || !root.contains(form) || pendingFindingForms.has(form)) return
    const input = form.elements.claim
    if (!input) return
    const claim = input.value
    const projectId = form.dataset.findingProject
    const experimentId = form.dataset.findingForm
    const epoch = bootEpoch
    const status = form.querySelector('[data-finding-status]')
    const button = form.querySelector('[type="submit"]')
    const current = () => !destroyed && source !== 'mock' && epoch === bootEpoch && root.contains(form)
      && form.elements.claim === input && form.dataset.findingProject === projectId && form.dataset.findingForm === experimentId
    let edited = false
    const onEdit = () => { edited = true }
    pendingFindingForms.add(form)
    input.addEventListener('input', onEdit)
    if (button) button.disabled = true
    if (status) status.textContent = 'Saving the finding…'
    try {
      const saved = await saveFinding({ projectId, claim, status: 'open' })
      if (!current()) return
      if (!saved?.ok) {
        const reason = String(saved?.reason || 'the research service did not answer').replace(/\.$/, '')
        if (status) status.textContent = saved?.sentence || `That was not saved — ${reason}. Try once more.`
        return
      }
      const newerDraft = edited || input.value !== claim
      if (status) status.textContent = `Recorded as ${saved.findingId}.` + (newerDraft ? ' Your newer text is still unsaved.' : '')
      if (!newerDraft) input.value = ''
      refreshFindings()
    } catch {
      if (current() && status) status.textContent = 'The save could not be confirmed. Your text is still here; check the findings before trying again.'
    } finally {
      pendingFindingForms.delete(form)
      input.removeEventListener('input', onEdit)
      if (current() && button) button.disabled = false
    }
  }
  moduleEl('results').addEventListener('submit', onFindingSubmit)
  moduleEl('designer').addEventListener('submit', onFindingSubmit)

  /* ---------- the gathered panel's service half ----------
     Filled asynchronously after the panel opens: the experiment's queued
     runs as the same drill rows the run board uses, then its results table,
     chart, exports and finding form built by the shared builders above. */

  async function renderGatheredService(experiment) {
    const host = moduleEl('designer').querySelector(`[data-gathered-service="${experiment.id}"]`)
    const serviceId = experiment.serviceExperimentId
    if (!host || !serviceId) return
    let read = runsByExperiment.get(serviceId)
    if (!read) {
      read = await readRuns(serviceId)
      runsByExperiment.set(serviceId, read)
    }
    if (destroyed) return
    if (read.ok !== true) {
      host.innerHTML = unavailableMarkup('Its run list', read.reason)
      return
    }
    if (read.runs.length === 0) {
      host.innerHTML = '<p class="research-observed-empty">No runs submitted yet.</p>'
      return
    }
    const cellsHost = moduleEl('designer').querySelector(`[data-gathered-cells="${experiment.id}"]`)
    if (cellsHost) cellsHost.innerHTML = localCellsMarkup(experiment, cellsWithServiceStatus(experiment, read.runs))
    const doneRuns = read.runs.filter(run => runIsTerminal(run?.task?.status))
    for (const run of doneRuns) {
      if (!resultsByRun.has(run.runId) || resultsByRun.get(run.runId)?.ok === false || resultsByRun.get(run.runId)?.readVersion !== resultReadVersion(run)) {
        const results = await readResults(run.runId)
        resultsByRun.set(run.runId, { ...results, readVersion: resultReadVersion(run) })
      }
    }
    if (destroyed) return
    const drills = read.runs.map(run => runDrillMarkup(run)).join('')
    const model = doneRuns.length > 0
      ? resultTableModel({ runs: doneRuns, resultsByRun, resultSchema: experiment.resultSchema })
      : null
    const column = model ? chosenColumn(serviceId, model, experiment.resultSchema) : null
    const columns = model ? chartableColumns(model, experiment.resultSchema) : []
    host.innerHTML = `
      <div class="research-runboard-cells">${drills}</div>
      ${model ? `
      <div class="research-results-exp">
        ${serviceCopyControlsMarkup(serviceId)}
        ${serviceResultsTableMarkup(model)}
        ${column && columns.length > 1 ? `
        <label class="research-chart-pick">Chart:
          <select data-chart-column="${esc(experiment.id)}">${columns.map(candidate => `
            <option value="${esc(candidate.name)}"${candidate.name === column.name ? ' selected' : ''}>${esc(candidate.label)}</option>`).join('')}
          </select>
        </label>` : ''}
        <div class="research-result-chart" data-gathered-chart="${esc(experiment.id)}" hidden></div>
        <p class="research-queue-form-status" data-service-results-status="${esc(serviceId)}" role="status"></p>
        ${findingFormMarkup(serviceId, experiment.projectId)}
      </div>` : ''}`
    gatheredCharts.get(experiment.id)?.destroy()
    gatheredCharts.delete(experiment.id)
    const mountGatheredChart = chosen => {
      gatheredCharts.get(experiment.id)?.destroy()
      gatheredCharts.delete(experiment.id)
      const chartHost = host.querySelector(`[data-gathered-chart="${experiment.id}"]`)
      if (!chosen || !chartHost) return
      chartHost.hidden = false
      const mounted = createResultChart(chartHost, { model, column: chosen })
      if (mounted) gatheredCharts.set(experiment.id, mounted)
      else chartHost.hidden = true
    }
    mountGatheredChart(column)
    host.querySelector(`[data-chart-column="${experiment.id}"]`)?.addEventListener('change', event => {
      chartChoice.set(serviceId, event.target.value)
      mountGatheredChart(columns.find(candidate => candidate.name === event.target.value) || null)
    })
  }

  /* ---------- project findings ----------
     The durable claims filed under the selected project, read through the
     research service and rendered in the working-lists module. The block is
     ONE element re-appended after the projection render, so a projection
     arriving late never wipes it. */

  const findingsBlock = el(`
    <div class="research-register-row" data-research-findings>
      <h3>Project findings</h3>
      <div data-research-findings-list><p class="research-observed-empty">Reading the findings.</p></div>
    </div>`)
  let findingsRead = null

  function renderFindingsList() {
    const host = moduleEl('worklists').querySelector('[data-research-worklists]')
    if (host && !findingsBlock.isConnected) host.appendChild(findingsBlock)
    const list = findingsBlock.querySelector('[data-research-findings-list]')
    /* The example face fills this block from the sample world through the same
       observation renderer the register lists use — it never asks the findings
       service, because in the example there is no service to ask and a
       "Reading the findings." line that can never settle is a small lie. This
       fork sits above the pick-a-project sentence on purpose: the example
       world has no projects to pick. */
    if (source === 'mock') {
      list.innerHTML = observationMarkup(SAMPLE_PROJECT_FINDINGS, { label: 'The findings list', emptyLabel: 'findings', itemMarkup: findingMarkup })
      return
    }
    if (selection === PROJECT_ALL || selection === PROJECT_UNFILED) {
      list.innerHTML = '<p class="research-observed-empty">Findings are filed under one project. Pick a project above to read its list.</p>'
      return
    }
    if (!findingsRead) {
      list.innerHTML = '<p class="research-observed-empty">Reading the findings.</p>'
      return
    }
    if (findingsRead.ok !== true) {
      list.innerHTML = unavailableMarkup('The findings list', findingsRead.reason)
      return
    }
    if (findingsRead.findings.length === 0) {
      list.innerHTML = '<p class="research-observed-empty">No findings are recorded under this project yet. Save one from a results table.</p>'
      return
    }
    list.innerHTML = `<ol class="research-register-list">${findingsRead.findings.map(item => {
      const detail = findingDetailsModel(item)
      const name = item?.findingId || item?.claim || 'this finding'
      return `<li class="research-finding-record">
        <span>Recorded status: ${esc(findingStateWord(item?.status))}${item?.findingId ? `<br><span class="research-finding-id">${esc(item.findingId)}</span>` : ''}</span>
        <div class="research-finding-content">
          <p>${esc(item?.claim || 'The claim text is missing.')}</p>
          <details class="research-finding-details">
            <summary aria-label="Evidence and reasoning for ${esc(name)}">Evidence and reasoning</summary>
            <p class="research-finding-review-note">${esc(detail.reviewNote)}</p>
            <dl>${detail.fields.map(field => `<div><dt>${esc(field.label)}</dt><dd>${field.structured
              ? `<pre>${esc(field.text)}</pre>` : esc(field.text)}</dd></div>`).join('')}</dl>
          </details>
        </div>
      </li>`
    }).join('')}</ol>`
  }

  async function refreshFindings() {
    if (selection === PROJECT_ALL || selection === PROJECT_UNFILED) {
      findingsRead = null
      renderFindingsList()
      return
    }
    const wanted = selection
    findingsRead = null
    renderFindingsList()
    const read = await readFindings(wanted)
    /* A slow answer for a project the person has already left is dropped —
       rendering it would file one project's findings under another's name. */
    if (destroyed || selection !== wanted) return
    findingsRead = read
    renderFindingsList()
  }

  /* ---------- the status strip ----------
     One honest sentence of load for the current selection: what is running,
     what waits, what finished — from the local cells and the service runs
     this page has actually read. Queued local cells are counted only when
     their service run list could not be read, so the same run is never
     counted twice. */

  function renderStatusPulse() {
    const pulse = bar.querySelector('[data-research-pulse]')
    if (!pulse) return
    /* The pulse runs on the example face too — it used to bail when simulated,
       so the one line that shows what the workbench feels like mid-run was
       exactly the line a visitor never saw. Under mock it counts the sample
       experiment's own cells (one running, one queued, one finished) through
       this same arithmetic; there is no service under mock, so the unread
       branch below simply never fires there. */
    let running = 0
    let queued = 0
    let finished = 0
    let collected = 0
    let dispatched = 0
    let executed = 0
    let unverified = 0
    let stalled = 0
    let unread = 0
    const okRead = id => {
      const read = id ? runsByExperiment.get(id) : null
      return read?.ok === true ? read : null
    }
    for (const experiment of experimentsSnapshot().experiments) {
      if (!filesUnder(selection, experiment.projectId)) continue
      const queuedThrough = experiment.serviceExperimentId
      const serviceRead = okRead(queuedThrough)
      for (const cell of experiment.cells) {
        if (cell.status === 'running' || cell.status === 'starting') running += 1
        else if (cell.status === 'finished') finished += 1
        // A queue-dispatched cell's local row stays 'queued' for life; the
        // service owns its real state. If the service could not be read, that
        // state is UNKNOWN — counting it as queued is how the pulse came to
        // say "0 finished" over seventeen finished runs when the capability
        // layer died (adversarial live review, 2026-08-15).
        else if (cell.status === 'queued') {
          if (queuedThrough && !serviceRead) unread += 1
          else if (!queuedThrough) queued += 1
        }
      }
    }
    for (const experiment of serviceExperiments()) {
      const read = okRead(experiment.experimentId)
      if (!read) continue
      for (const run of read.runs) {
        const status = run?.task?.status
        if (runTaskIsStalled(run?.task)) stalled += 1
        else if (status === 'running' || status === 'leased') running += 1
        else if (status === 'queued' || status === 'retry_wait') queued += 1
        else if (status === 'succeeded') {
          const display = runTaskDisplayStatus(run?.task)
          if (display === 'collected') collected += 1
          else if (display === 'dispatched') dispatched += 1
          else if (display === 'executed') executed += 1
          else unverified += 1
        }
      }
    }
    const counted = `${running} running · ${queued} queued · ${finished} sessions finished${collected ? ` · ${collected} results collected` : ''}${dispatched ? ` · ${dispatched} dispatched` : ''}${executed ? ` · ${executed} execution only` : ''}${unverified ? ` · ${unverified} unverified` : ''}${stalled ? ` · ${stalled} stalled` : ''}`
    if (unread === 0) {
      lastKnownPulse = counted
      pulse.textContent = running === 0 && queued === 0 && finished === 0 && collected === 0 && dispatched === 0 && executed === 0 && unverified === 0 && stalled === 0
        ? 'nothing running'
        : counted
      return
    }
    // Say what is not known rather than a number that stands in for it.
    pulse.textContent = lastKnownPulse
      ? `${lastKnownPulse} — last known; the run service could not be read just now`
      : `${unread} cell${unread === 1 ? '' : 's'} are with the run service, which could not be read just now`
  }

  function renderServiceModules() {
    renderProjectBar()
    renderSessionsModule()
    renderServiceRunBoard()
    renderServiceResults()
    renderStatusPulse()
  }

  async function refreshServiceSnapshot() {
    const epoch = bootEpoch
    /* The verdict can flip to 'mock' while this read is in flight (sign-out,
       the example toggle). Landing the snapshot anyway would hand the example
       face a real service object — and the pulse would then report the run
       service unreadable over sample data. Read into a local, land it only in
       a world that still wants it. */
    const read = await assignmentStore.readServiceSnapshot(readResearchSnapshot)
    const assignmentReadVersion = read.assignmentReadVersion
    if (destroyed || source === 'mock' || epoch !== bootEpoch) return
    service = read
    projectActivity.setContext(service.ok ? { source, epoch, destination: read.assignmentDestination ?? null, assignments: service.assignments } : null)
    reconcileSelection()
    if (read.assignmentReadFailure) assignmentReadError = read.assignmentReadFailure
    else if (service.ok) {
      const adopted = assignmentStore.adoptServiceRows(service.assignments, { readVersion: assignmentReadVersion, assignmentDestination: read.assignmentDestination })
      assignmentReadError = adopted.ok === false ? adopted.sentence : null
      if (adopted.ok) assignmentStore.flushPending().then(result => {
        if (destroyed || source === 'mock') return
        assignmentReadError = result.ok === false ? result.sentence : null
        renderSessionsModule()
      })
    }
    renderServiceModules()
    refreshFindings()
    refreshRuns()
  }

  /* ---------- boot ----------
     ONE render path. The fork below chooses INPUTS, never renderers: 'local'
     and 'relay' run the live loaders against this machine or the tunnel to
     it, 'mock' hands the sample world to the very same functions. The verdict
     is re-resolved whenever the host announces DATA_SOURCE_EVENT (sign-in,
     sign-out, the example toggle), and every asynchronous continuation checks
     the epoch it was born under, so a slow answer from the old world can
     never paint over the new one. */

  mountLayout()

  let bootEpoch = 0

  function renderMockWorld() {
    /* The example world behaves as "All projects": the select is disabled on
       this face, and pinning the in-memory selection to match keeps every
       project filter (bench cards, pulse arithmetic, findings) showing the
       whole sample. The STORED preference is deliberately untouched — mock
       never writes — and renderLiveWorld reads it back on the way out. */
    selection = PROJECT_ALL
    service = null
    runsByExperiment.clear()
    resultsByRun.clear()
    lastKnownPulse = null
    /* Leftovers a source flip would otherwise strand: the service board and
       service results are siblings the bench renderers are forbidden to
       delete, so the one face with no service behind it removes them here,
       charts first. */
    for (const chart of serviceCharts.values()) chart.destroy()
    serviceCharts.clear()
    for (const chart of gatheredCharts.values()) chart.destroy()
    gatheredCharts.clear()
    moduleEl('runboard').querySelector('[data-service-runboard]')?.remove()
    moduleEl('results').querySelector('[data-service-results]')?.remove()
    projectSelect.innerHTML = `<option value="${PROJECT_ALL}">All projects</option>`
    projectSelect.disabled = true
    projectNewBtn.hidden = true
    /* A greyed control with nothing beside it is indistinguishable from a
       broken one. The failure face explains itself; this one used to say
       nothing, so the only way to learn why the picker was dead was to guess. */
    projectStatus.textContent = 'Saved account projects need a connected workspace. Open a local draft or load an example above to work here.'
    root.querySelector('[data-research-source]').textContent = EXAMPLE_MAST
    renderResearchQueue(SAMPLE_QUEUE)
    renderProjection({ data: SAMPLE_PROJECTION })
    renderFindingsList()
    renderTiers({
      ok: true,
      receipt: {
        freeRamMiB: 24576, freeVramMiB: 10240, gpuTemperatureC: 41, onBattery: false,
        fast: { model: 'hermes3:8b', enabled: true, ready: true, reason: null },
        strong: { model: 'gpt-oss:20b', enabled: true, ready: false, reason: 'fresh_load_free_vram_below_6.5GiB' },
      },
    })
    /* The REAL designer renders on the example face — form, preview, starter
       templates and the sample experiment's card all work, because they are
       the page's own renderers over local, pure helpers; only the presses
       that would persist or start something are refused (EXAMPLE_WRITE_
       REFUSAL, at the handlers). The old face replaced this module with one
       sentence, which left the product's largest surface invisible to exactly
       the visitor the example exists for. */
    /* A signed-out LIVE visit leaves experimentsSignedOut raised, and
       renderDesigner honours that flag before anything else — so without this
       reset a flip into the example would show "Sign in to design
       experiments" over sample data. The example is not signed anything; it
       is the example. */
    experimentsSignedOut = false
    seedExperiments({ experiments: [SAMPLE_EXPERIMENT], damaged: false })
    renderExperimentModules()
    renderSessionsModule()
    root.dataset.projectionState = 'simulated'
    root.setAttribute('aria-busy', 'false')
  }

  function renderLiveWorld() {
    const epoch = bootEpoch
    const alive = () => !destroyed && epoch === bootEpoch
    /* The stored project choice belongs to the person's own data; re-read it
       on every entry so a trip through the example (which pins 'all' in
       memory) hands back exactly the selection they left. */
    selection = readProjectSelection(typeof window === 'undefined' ? null : window.localStorage)
    root.setAttribute('aria-busy', 'true')
    root.querySelector('[data-research-source]').textContent = 'reading your research…'

    Promise.all([
      fetchResearchQueue().catch(error => ({ ok: false, reason: error?.message || String(error) })),
      readQueueRow(),
    ]).then(([authored]) => {
      if (!alive()) return
      authoredQueue = authored
      renderQueueModuleLive()
    })

    readExperimentsRow().then(() => {
      if (alive()) renderExperimentModules()
    })

    refreshServiceSnapshot()

    localTiersStatus().then(result => {
      if (alive()) renderTiers(result)
    }, error => {
      if (alive()) renderTiers({ ok: false, reason: error?.message || String(error) })
    })

    fetchResearch().then(result => {
      if (!alive()) return
      if (!result.ok) { renderUnavailable(result); return }
      renderProjection(result.data)
    }, error => {
      if (alive()) renderUnavailable({ ok: false, reason: error?.message || String(error) })
    })
  }

  async function applyDataSource() {
    const epoch = ++bootEpoch
    projectActivity.setContext(null)
    const verdict = await resolveDataSource()
    if (destroyed || epoch !== bootEpoch) return
    source = verdict
    benchmarkBuilder.setContext(selection, source, { reload: true })
    /* The badge follows the SOURCE and never the look of the data: mock is
       marked, real data — local and relay alike — never is. The attribute
       keeps its two established values because styles and drives key on
       them. */
    root.dataset.liveMode = sourceIsBadged(verdict) ? 'simulated' : 'live'
    /* renderUnavailable inserts its banner after the mast on every call; a
       re-boot must clear the old one or a flip out of an unavailable live
       state would leave "no report library" standing over the example. */
    root.querySelector('[data-research-unavailable]')?.remove()
    if (verdict === 'mock') renderMockWorld()
    else renderLiveWorld()
  }

  /* The event deliberately carries no verdict (see src/data-source.js), so
     the answer is re-resolved from scratch — even an unchanged verdict
     re-runs its loaders, which is exactly right after a sign-in that kept the
     source 'local' but made the account rows readable. */
  const onDataSourceChanged = () => { applyDataSource() }
  window.addEventListener(DATA_SOURCE_EVENT, onDataSourceChanged)
  applyDataSource()

  return {
    el: root,
    destroy() {
      destroyed = true
      projectActivity.destroy()
      stepSync.disconnect()
      benchmarkBuilder.destroy()
      dataWorkspace.destroy()
      for (const chart of serviceCharts.values()) chart.destroy()
      serviceCharts.clear()
      for (const chart of gatheredCharts.values()) chart.destroy()
      gatheredCharts.clear()
      if (runPollTimer) { clearTimeout(runPollTimer); runPollTimer = null }
      document.removeEventListener('pointerdown', onDocPointer)
      document.removeEventListener('keydown', onDocKey)
      window.removeEventListener(RESEARCH_EXPERIMENTS_EVENT, onExperimentsChanged)
      window.removeEventListener(DATA_SOURCE_EVENT, onDataSourceChanged)
      layout?.destroy()
    },
  }
}
