/* THE TWO PANELS THE OWNER COULD NOT READ, BUILT FROM THE PRODUCT'S OWN CODE.
 *
 * Every string below comes out of a module the application loads. Nothing here
 * retypes a sentence: a fixture that carried its own copy of the words would go
 * on passing after the product's words changed, which is the failure mode that
 * makes a copy suite worthless.
 *
 * WHAT A "STATE" IS HERE. One panel, one situation, and every string that
 * situation puts in front of a person at the same moment -- the status lines,
 * the form labels and placeholders, the counter, the accessible name of the
 * register. Plus how many rows the register has, because two of the three rules
 * in ./composed-output-rules.mjs are about the relationship between the words
 * and the list.
 *
 * THE STATES ARE THE ONES A PERSON REACHES, not a sampling. A fresh profile with
 * nothing signed in is first, because that is the state the owner met.
 */

import {
  bindingText,
  cloudAvailability,
  createCloudTaskController,
  findEnvironment,
} from '../../src/cloud-tasks-controller.js'
import {
  CHAIN_NOTE,
  DECISION_FORM,
  EMPTY_LIST,
  FILE_BOX,
  HIDE_ROW,
  PROPOSED_NOTE,
  QUEUE_FORM,
  REGISTER_NOTICE_STATES,
  REMOVED_TOGGLE,
  SCOPE_FILTER,
  decisionOff,
  queueSnapshotLine,
  registerNotice,
} from '../../src/ledger-copy.js'
import {
  COMMS_NAME,
  EXAMPLE_BADGE,
  LOADING_LINE,
  READER_REFUSALS,
  LOAD_FAILED,
  UNREADABLE_SUB,
  boardEmptyLine,
  describe,
  emptyLine,
  inventoryLine,
  readStateWord,
} from '../../src/comms-copy.js'
import {
  FENCE_REFUSAL_CODES,
  FILES_PANEL,
  filesPanelSlots,
  openWhy,
  readWhy,
} from '../../src/agent-files-copy.js'
import { commsQuietNotice, hostAbsentNotice } from '../../src/first-run-needs.js'
import { sampleOpsEnvelope } from '../../src/sample-comms.js'

const NEVER = Object.freeze({ setTimeout: () => 0, clearTimeout: () => {} })

/* A bridge that answers from a table. Every reply below is a shape this
   product's own mission bridge really returns. */
function replier(table) {
  return async (action, body) => {
    const answer = table[action]
    if (typeof answer === 'function') return answer(body)
    if (answer === undefined) return { ok: false, code: 'BRIDGE_ACTION_UNKNOWN', reason: 'unknown bridge action' }
    return answer
  }
}

async function cloudState({ id, why, availability, replies, list = null }) {
  const controller = createCloudTaskController({
    postAction: replier(replies),
    availability,
    timers: NEVER,
  })
  /* Through the panel's own refresh, in the order the Refresh button uses, so
     the matrix measures what a person actually gets. */
  try {
    await controller.refresh()
    const state = controller.getState()
    return {
      panel: 'codex-cloud',
      state: id,
      why,
      slots: [
        { name: 'the panel’s own note', tone: 'note', text: state.note },
        { name: 'the task list line', tone: state.listTone, text: state.listMessage },
        { name: 'the environments line', tone: state.environmentsTone, text: state.environmentsMessage },
        { name: 'the launch line', tone: state.launchTone, text: state.launchMessage },
        { name: 'the watch line', tone: state.watchTone, text: state.watchMessage },
        /* The line that says where a task would land. It is on the panel at the
           same moment as everything above, so it is measured with them. */
        { name: 'the binding line', tone: 'note', text: bindingText(findEnvironment(state, state.environments[0]?.environmentId), state) },
      ],
      list: list === null ? { name: 'the task list', itemCount: state.tasks.length } : list,
    }
  } finally {
    controller.destroy()
  }
}

const READY = cloudAvailability({ writeEnabled: true, inShell: true })
const SWITCHED_OFF = cloudAvailability({ writeEnabled: false, inShell: true })

const ACCOUNT = Object.freeze({ name: 'work', role: 'builder', canServe: true, usedPercent: 12 })
const ENVIRONMENT = Object.freeze({
  environmentId: 'a'.repeat(32),
  label: 'Owner/repo',
  repository: 'Owner/repo',
  defaultBranch: 'main',
  accounts: ['work'],
  launchable: true,
})

/* THE REFUSAL THIS READ CAN STILL PRODUCE, and it is deliberately not the one
   the panel used to show.
 *
 * A MISSING registry is no longer a refusal at all -- it is the empty state
   above, because "nobody has signed in here" is an answer. What is left is a
   registry that IS there and cannot be trusted, which is a different fact with
   a different repair. The reason below is the engine's own sentence for it,
   exactly as it arrives after typedError() scrubs the file path out of it. */
const REGISTRY_UNREADABLE = Object.freeze({
  ok: false,
  code: 'ACCOUNTS_REGISTRY_UNPARSABLE',
  reason: 'The account registry is not valid JSON, so no account can be selected.',
})

export async function cloudPanels() {
  return [
    await cloudState({
      id: 'no-account-signed-in',
      why: 'a fresh profile: the reader has never signed in to Codex Cloud on this computer',
      availability: READY,
      replies: {
        'cloud-accounts': { ok: true, receipt: { accounts: [], defaultAccount: null, environments: [], environmentsComplete: true, environmentsReadAt: '2026-08-18T00:00:00.000Z' } },
        'cloud-tasks': { ok: true, receipt: { tasks: [], account: null } },
      },
    }),
    await cloudState({
      id: 'account-registry-unreadable',
      why: 'a registry that is there and cannot be trusted, which is not the same as one that is absent',
      availability: READY,
      replies: { 'cloud-accounts': REGISTRY_UNREADABLE, 'cloud-tasks': REGISTRY_UNREADABLE },
    }),
    await cloudState({
      id: 'bridge-unreachable',
      why: 'the background service this window talks to is not answering',
      availability: READY,
      replies: {
        'cloud-accounts': { ok: false, code: 'BRIDGE_UNREACHABLE', reason: 'The audited connection is not answering.' },
        'cloud-tasks': { ok: false, code: 'BRIDGE_UNREACHABLE', reason: 'The audited connection is not answering.' },
      },
    }),
    await cloudState({
      id: 'switched-off',
      why: 'the feature ships off and the panel is drawn anyway, so the switch can be found',
      availability: SWITCHED_OFF,
      replies: {},
    }),
    await cloudState({
      id: 'populated',
      why: 'one account, one environment, one finished task',
      availability: READY,
      replies: {
        'cloud-accounts': { ok: true, receipt: { accounts: [ACCOUNT], defaultAccount: 'work', environments: [ENVIRONMENT], environmentsComplete: true, environmentsReadAt: '2026-08-18T00:00:00.000Z' } },
        'cloud-tasks': { ok: true, receipt: { tasks: [{ taskId: 'task-00000001', title: 'Read the README', state: 'SUCCEEDED' }], account: ACCOUNT } },
      },
    }),
  ]
}

/* ------------------------------------------------------------ the ledger -- */

/* The bridge's status reply carries one entry per folder. `ok: false` is what a
   folder whose work list could not be inspected looks like. */
const QUEUE_READY = Object.freeze({ ok: true, hash: 'f'.repeat(64) })
const QUEUE_REFUSED = Object.freeze({ ok: false, code: 'BRIDGE_GUARD_REFUSED', reason: 'That folder has no work list to read.' })

/* TWO SUBJECTS ON ONE PAGE, and the panel is allowed to say different things
   about them. The register is the person's requests. The line under Claim and
   Close is about a FOLDER's build queue, which is a different list with a
   different reason for being unreadable. What the page may not do is tell two
   stories about the same one. */
const REQUESTS = 'your requests'
const WORK_LIST = 'a folder’s work list'

/* The reach filter beside the R/Q tabs, drawn in every state of the R tab:
   its accessible name and its five labels, as one line the way a screen reader
   walks them. */
const SCOPE_FILTER_LINE = `${SCOPE_FILTER.label}: ${['all', 'global', 'tree', 'session', 'thread'].map(scope => SCOPE_FILTER[scope]).join(', ')}`

function ledgerState({ id, why, source, itemCount, snapshot, formsOn = true, hiddenCount = 0, hiddenId = null, removedCount = 0, proposedBy = null, chain = null, filterOn = true }) {
  const notice = registerNotice(source)
  const line = queueSnapshotLine(snapshot)
  /* The state the surface is handed, exactly as src/views/ledger.js hands it:
     the VISIBLE rows, after any the person hid on this screen. */
  const register = { kind: notice ? notice.state : (source.kind === 'live' ? 'live' : source.kind), items: rowsFor(itemCount) }
  /* The counter as the view composes it (src/views/ledger.js renderRegister):
     the visible count, the column caption, the hidden tail when any row is
     hidden on this screen, and the removed tail while removed rows are shown. */
  const counter = `${itemCount} requests · with their status and gates${hiddenCount > 0 ? ` · ${HIDE_ROW.count(hiddenCount)}` : ''}${removedCount > 0 ? ` · ${REMOVED_TOGGLE.count(removedCount)}` : ''}`
  const slots = [
    { name: 'the register’s paragraph', subject: REQUESTS, tone: notice ? notice.tone : 'note', text: notice ? notice.body : (itemCount === 0 ? EMPTY_LIST.r : '') },
    { name: 'the register’s accessible name', subject: REQUESTS, tone: notice ? notice.tone : 'note', text: notice ? notice.label : '' },
    { name: 'the counter above the register', subject: REQUESTS, tone: notice ? notice.tone : 'note', text: notice ? notice.count : counter },
  ]
  if (filterOn) {
    slots.push(
      { name: 'the reach filter', subject: REQUESTS, tone: 'note', text: SCOPE_FILTER_LINE },
      { name: 'the removed toggle', subject: REQUESTS, tone: 'note', text: removedCount > 0 ? REMOVED_TOGGLE.hide : REMOVED_TOGGLE.show },
    )
  }
  if (hiddenId) {
    /* The toolbar note after a hide -- tone note, never a failure, and it must
       not tell a second story against the counter beside it. */
    slots.push({ name: 'the hidden-rows note', subject: REQUESTS, tone: HIDE_ROW.tone, text: HIDE_ROW.hiddenR(hiddenId) })
  }
  if (chain) {
    /* The history note above the rows: the chain broke, or a record drifted.
       Painted as a failure, about the history and not about the list --
       the rows are still drawn beneath it. */
    slots.push({ name: 'the history note', subject: 'the ledger’s history', tone: chain === 'broken' ? 'refused' : 'unavailable', text: chain === 'broken' ? CHAIN_NOTE.broken : CHAIN_NOTE.drift(['R1101']) })
  }
  if (proposedBy) {
    /* Under a row an agent filed and nobody has approved yet. */
    slots.push({ name: 'the note under a proposed row', subject: REQUESTS, tone: PROPOSED_NOTE.tone, text: PROPOSED_NOTE.text(proposedBy) })
  }
  /* THE FILE BOX at the foot of the page, drawn in every state that has a
     filing seam: its title, the reach sentence under the picker, and the hint
     under the words. Measured with the register because it is on screen with
     it, and its reach sentence must not read as a second story about the
     list above it. */
  slots.push(
    { name: 'the file box title', subject: 'filing a request', tone: 'note', text: FILE_BOX.title },
    { name: 'the sentence under the file box picker', subject: 'filing a request', tone: 'note', text: `${FILE_BOX.scopeLabel} — ${FILE_BOX.reach.global}` },
    { name: 'the sentence under the file box words', subject: 'filing a request', tone: 'note', text: `${FILE_BOX.wordsLabel} — ${FILE_BOX.wordsHint}` },
  )
  if (formsOn) {
    /* The hint the form really shows: the reason it is off when it is off, and
       otherwise the sentence that matches whether the field is a picker or a
       typed box. This is the same choice src/write-surfaces.js makes. */
    const off = decisionOff(register)
    const hint = off ? off.text : (register.items.length > 0 ? DECISION_FORM.targetHint : DECISION_FORM.targetHintTyped)
    slots.push(
      { name: 'the Approve/Decline form title', subject: REQUESTS, tone: 'note', text: DECISION_FORM.title },
      { name: 'the “Which request” field', subject: REQUESTS, tone: off ? off.tone : 'note', text: `${DECISION_FORM.targetLabel} — ${hint}` },
      { name: 'the Claim/Close form title', subject: WORK_LIST, tone: 'note', text: QUEUE_FORM.title },
      { name: 'the “Which item” field', subject: WORK_LIST, tone: 'note', text: `${QUEUE_FORM.itemLabel} — ${QUEUE_FORM.itemHint}` },
      { name: 'the line under Claim and Close', subject: WORK_LIST, tone: line.tone, text: line.text },
    )
  }
  return {
    panel: 'r-ledger',
    state: id,
    why,
    slots,
    list: { name: 'the request register', itemCount },
  }
}

function rowsFor(itemCount) {
  return Array.from({ length: itemCount }, (unused, index) => ({
    id: `R${1100 + index}`,
    label: `R${1100 + index} · open`,
  }))
}

export function ledgerPanels() {
  /* Every no-rows state the copy module declares, plus the one with rows. A
     state added to the product arrives here without anybody remembering to add
     it, which is the only way a matrix stays honest. */
  const notices = REGISTER_NOTICE_STATES.map(kind => ledgerState({
    id: `register-${kind}`,
    why: `the register has no rows to draw and says so as "${kind}"`,
    source: { kind },
    itemCount: 0,
    snapshot: QUEUE_REFUSED,
  }))
  return [
    ...notices,
    ledgerState({
      id: 'register-populated',
      why: 'a checkout that really does keep a register, with the work list read',
      source: { kind: 'live' },
      itemCount: 4,
      snapshot: QUEUE_READY,
    }),
    ledgerState({
      id: 'register-populated-one-hidden',
      why: 'the same register after the person hid one row with the ×: the counter carries the tail and the toolbar note says what happened',
      source: { kind: 'live' },
      itemCount: 3,
      snapshot: QUEUE_READY,
      hiddenCount: 1,
      hiddenId: 'R1103',
    }),
    ledgerState({
      id: 'register-populated-with-proposed',
      why: 'a register with a rule an agent filed from the person\'s words, waiting for approval: the row carries its own note and its Approve and Decline',
      source: { kind: 'live' },
      itemCount: 4,
      snapshot: QUEUE_READY,
      proposedBy: 'codex',
    }),
    ledgerState({
      id: 'register-populated-showing-removed',
      why: 'the same register with "Show removed" on: the counter carries the removed tail and the toggle offers to hide them again',
      source: { kind: 'live' },
      itemCount: 5,
      snapshot: QUEUE_READY,
      removedCount: 1,
    }),
    ledgerState({
      id: 'register-narrowed-to-nothing',
      why: 'a register whose reach filter hides every row: the list sentence says so and names the two ways to file, with no failure anywhere',
      source: { kind: 'live' },
      itemCount: 0,
      snapshot: QUEUE_READY,
    }),
    ledgerState({
      id: 'register-history-broken',
      why: 'the chained history behind the ledger did not verify: the note says so above rows that are still drawn',
      source: { kind: 'live' },
      itemCount: 4,
      snapshot: QUEUE_READY,
      chain: 'broken',
    }),
    ledgerState({
      id: 'register-history-drift',
      why: 'one record changed outside the product after it was filed: the note names it above rows that are still drawn',
      source: { kind: 'live' },
      itemCount: 4,
      snapshot: QUEUE_READY,
      chain: 'drift',
    }),
  ]
}

/* ------------------------------------------------------- agent comms -- */

/* THE PAGE THAT SAID ONE THING SIX WAYS. The comms page's defect was never a
   single string: one count in four nouns across one header row, one refusal
   stamped into every tile, the topic bar and the rail foot. So the panel is
   composed here exactly as src/views/comms.js composes it -- the title, the
   inventory line, the one notice, the topic bar of the first channel, the
   empty line a channel shows, the empty line the board shows -- for each state
   a person reaches, and measured as one thing. */
const MESSAGES = 'messages between agents'
const INVENTORY = 'what this computer has on record'

function commsState({ id, why, data, notice = '', stateName, itemCount, quiet = false, unreadable = false, badge = '' }) {
  const channels = data?.channels?.ok && Array.isArray(data.channels.value) ? data.channels.value : []
  const first = channels[0] || null
  /* Exactly the view's rule: the per-channel and per-board empty lines are off
     while the notice above the card (or the quiet notice) explains the whole
     page, and the topic bar draws nothing when there is no channel. */
  const emptyHidden = Boolean(notice) || quiet || unreadable
  const slots = [
    { name: 'the title', subject: INVENTORY, tone: 'note', text: COMMS_NAME },
    { name: 'the line under the title', subject: INVENTORY, tone: unreadable ? 'unavailable' : 'note', text: unreadable ? UNREADABLE_SUB : (data ? inventoryLine(data) : '') },
    { name: 'the word beside the dot', subject: INVENTORY, tone: 'note', text: readStateWord(stateName) },
  ]
  if (badge) slots.push({ name: 'the example badge', subject: INVENTORY, tone: 'note', text: badge })
  if (notice) slots.push({ name: 'the notice under the header', subject: MESSAGES, tone: 'refused', text: notice })
  if (unreadable) {
    const absent = hostAbsentNotice(LOAD_FAILED('no reason given'))
    slots.push({ name: 'the notice under the header', subject: INVENTORY, tone: 'unavailable', text: `${absent.title} ${absent.reason} ${absent.body}` })
  }
  if (first) slots.push({ name: 'the topic bar', subject: MESSAGES, tone: 'note', text: describe(first) })
  /* while the first read is in flight the one pending tile carries the loading line as its topic */
  if (!data && !unreadable) slots.push({ name: 'the topic bar', subject: MESSAGES, tone: 'note', text: LOADING_LINE })
  if (first && itemCount === 0 && !emptyHidden) slots.push({ name: 'the empty line in a channel', subject: MESSAGES, tone: 'note', text: emptyLine() })
  if (!first && !emptyHidden && data) slots.push({ name: 'the empty line on the board', subject: MESSAGES, tone: 'note', text: boardEmptyLine() })
  if (quiet) slots.push({ name: 'the quiet notice', subject: MESSAGES, tone: 'note', text: commsQuietNotice().body })
  return {
    panel: 'agent-comms',
    state: id,
    why,
    slots,
    list: { name: 'the message log', itemCount },
  }
}

/* A report with the live reader's own channel and nothing else on record: what
   a fresh install that can read its journal actually hands the page. */
const bareReport = (messages) => ({
  declaredServices: [],
  channels: { ok: true, reason: null, observedAt: null, value: [{ id: 'agent-tree', name: 'agents on this computer', state: 'healthy', observedAt: null, detail: `${messages.ok ? messages.value.length : 0} messages between agents on this computer's tree` }] },
  mcp: { ok: false, reason: 'the services on record could not be read', observedAt: null, value: null },
  messages,
})

export function agentCommsPanels() {
  const sample = sampleOpsEnvelope(Date.parse('2026-08-20T12:00:00.000Z'))
  const firstSampleCount = sample.messages.value.filter(m => m.channelId === sample.channels.value[0].id).length
  return [
    commsState({
      id: 'loading',
      why: 'the first read has not answered yet',
      data: null,
      stateName: 'loading',
      itemCount: 0,
    }),
    commsState({
      id: 'ready',
      why: 'the report and the messages both read; channels with traffic',
      data: sample,
      stateName: 'ready',
      itemCount: firstSampleCount,
    }),
    commsState({
      id: 'partial',
      why: 'the report read but the message reader refused: one notice above the card, no sentence inside it',
      data: { ...sample, messages: { ok: false, reason: READER_REFUSALS.NO_READER, observedAt: null, value: null } },
      notice: READER_REFUSALS.NO_READER,
      stateName: 'partial-unavailable',
      itemCount: 0,
    }),
    commsState({
      id: 'unreadable',
      why: 'the whole read failed: no tiles, no rail rows, the host-absent notice once, and no count anywhere',
      data: null,
      stateName: 'unavailable',
      itemCount: 0,
      unreadable: true,
    }),
    commsState({
      id: 'example',
      why: 'the example source: the same sample report, badged',
      data: sample,
      stateName: 'simulated',
      itemCount: firstSampleCount,
      badge: EXAMPLE_BADGE,
    }),
    commsState({
      id: 'quiet',
      why: 'a fresh install whose journal reads fine and is empty: the quiet notice explains, the empty lines stay off',
      data: bareReport({ ok: true, reason: null, observedAt: null, value: [] }),
      stateName: 'ready',
      itemCount: 0,
      quiet: true,
    }),
  ]
}

/* ------------------------------------------------------------------ *
 * THE FILES-AND-REPORTS PANEL.
 *
 * IT HAS MORE STATES THAN ANYTHING ELSE IN THIS MATRIX -- no application behind
 * the page, no folder set up, an empty folder, three ways the fence can be
 * absent, a folder that cannot be read, a folder cut short, and a row whose Open
 * is refused -- and every one of them is a state a person reaches on a real
 * computer rather than a state somebody invented for a screenshot.
 *
 * BUILT FROM THE PANEL'S OWN COMPOSITION FUNCTION. filesPanelSlots() is what
 * the renderer applies, so the gate measures the same decision the screen
 * makes. Nothing below retypes a sentence.
 * ------------------------------------------------------------------ */

const FILE_ROWS = Object.freeze([
  Object.freeze({ name: 'REPORT-the-run.md', bytes: 4200, changedAt: '2026-08-26T10:00:00.000Z', kind: 'report', readable: true, openable: true }),
  Object.freeze({ name: 'invoice.pdf', bytes: 91000, changedAt: '2026-08-25T10:00:00.000Z', kind: 'other', readable: false, openable: true }),
  Object.freeze({ name: 'cleanup.bat', bytes: 120, changedAt: '2026-08-24T10:00:00.000Z', kind: 'script', readable: true, openable: false }),
])

const A_FOLDER = Object.freeze({ ok: true, folders: [Object.freeze({ id: 'chosen-0', kind: 'chosen', name: 'Work' })] })

function filesState({ id, why, available = true, folders = A_FOLDER, list = null, action = null }) {
  const slots = filesPanelSlots({ available, folders, list, action })
  const rows = slots.rows ? (list?.files || []) : []
  return {
    panel: 'agent-files',
    state: id,
    why,
    slots: [
      /* THE TWO SENTENCES THAT ARE ALWAYS THERE, and they are about a different
         thing from everything below: where this list comes from, and what this
         product does not record. Declared as their own subject so that "nothing
         yet records which of them an agent wrote" is not read as this folder
         reporting itself empty. */
      { name: 'where the list comes from', tone: 'note', subject: 'what this panel lists', text: FILES_PANEL.source },
      { name: 'what nothing on this computer records', tone: 'note', subject: 'what this panel lists', text: FILES_PANEL.honesty },
      { name: 'the notice above the controls', tone: slots.controlsWhy ? 'refused' : 'note', subject: 'this folder', text: slots.notice },
      { name: 'the line where the rows would be', tone: slots.refusal ? 'refused' : 'note', subject: 'this folder', text: slots.listLine },
      { name: 'the line above the list', tone: 'note', subject: 'this folder', text: slots.listNote },
      { name: 'the line under the list', tone: slots.tone || 'note', subject: 'this folder', text: slots.status },
      { name: 'the reason beside a switched-off Open', tone: 'note', subject: 'this file', text: rows.map(file => openWhy(file, { available })).find(Boolean) || '' },
      { name: 'the reason beside a switched-off Read here', tone: 'note', subject: 'this file', text: rows.map(file => readWhy(file, { available })).find(Boolean) || '' },
    ],
    list: { name: 'the file list', itemCount: rows.length },
  }
}

function agentFilesPanels() {
  const listed = { ok: true, folderId: 'chosen-0', total: FILE_ROWS.length, truncated: false, files: FILE_ROWS }
  return [
    filesState({
      id: 'no-application',
      why: 'a browser looking at this product: every control drawn and switched off, one sentence saying why',
      available: false,
      folders: null,
    }),
    filesState({
      id: 'no-folder-yet',
      why: 'nobody has set a folder up: the notice sends them to Settings and Refresh stays live',
      folders: { ok: true, folders: [] },
    }),
    filesState({
      id: 'folder-is-empty',
      why: 'the folder read fine and has nothing in it, which is an answer rather than a failure',
      list: { ok: true, folderId: 'chosen-0', total: 0, truncated: false, files: [] },
    }),
    ...FENCE_REFUSAL_CODES.map(code => filesState({
      id: `no-fence-${code.toLowerCase().replace(/^files_/, '').replace(/_/g, '-')}`,
      why: 'this copy of the program cannot judge a path, so nothing on the panel can succeed and nothing is offered',
      list: { ok: false, code, reason: 'the shell’s own diagnostic, which never reaches the glass' },
    })),
    filesState({
      id: 'folder-cannot-be-read',
      why: 'the folder is gone or unreadable: the sentence sits where the rows would be, and the status line stays out of it',
      list: { ok: false, code: 'FILES_FOLDER_UNREADABLE', reason: 'That folder could not be read (EPERM).' },
    }),
    filesState({
      id: 'files',
      why: 'three rows: one this window shows and opens, one it only opens, one it shows and will never hand over',
      list: listed,
    }),
    filesState({
      id: 'more-files-than-fit',
      why: 'a folder cut to the newest rows, and told so in figures',
      list: { ...listed, total: 900, truncated: true },
    }),
    filesState({
      id: 'this-computer-refused-the-open',
      why: 'the press reached Windows and nothing there opens that kind: the list is still on screen behind the sentence',
      list: listed,
      action: { verb: 'open', result: { ok: false, code: 'FILES_NO_PROGRAM', reason: 'Failed to open path' } },
    }),
    filesState({
      id: 'the-file-was-opened',
      why: 'the ordinary success, which still has to say something a person can act on',
      list: listed,
      action: { verb: 'open', result: { ok: true, name: 'invoice.pdf' } },
    }),
  ]
}

export async function composedPanels() {
  return [...(await cloudPanels()), ...ledgerPanels(), ...agentCommsPanels(), ...agentFilesPanels()]
}
