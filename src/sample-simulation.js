/* THE EXAMPLE FLEET AT WORK.
 *
 * WHAT THIS IS FOR. The example trees (src/sample-trees.js) used to show a
 * person three frozen snapshots: something finished, something running,
 * something that failed. A frozen tree cannot show how the product WORKS -- a
 * controller splitting a job, managers handing out the pieces, a builder's
 * commands going past, a reviewer sending a change back, an agent waiting out a
 * usage limit and carrying on by itself. This module plays one tree through all
 * of that, on a loop, on the example only.
 *
 * NOTHING HERE REACHES ANYTHING. No engine, provider, account, network or
 * storage. Every change to the tree goes through the example's own store --
 * the real store over a memory backing, see sample-trees.js -- so the page's
 * own drawing code shows it unmodified. Everything else (what an agent is
 * doing, the words it is writing, the rows its chat shows) is returned to the
 * caller as plain data to draw. The session ids are the example's own
 * (SAMPLE_SIM_SESSION_PREFIX); they exist because the store will not call an
 * agent running without one, and they are never handed to the agent bridge.
 *
 * DETERMINISTIC. The script below is a fixed table and time is the only input
 * besides the seed, which only varies token counts and the rhythm of the
 * streamed words. The same seed at the same moment gives the same tree, so a
 * screenshot can be compared with the next one.
 *
 * NO FLUID OR FIELD EFFECTS. This is agents' states and activity only; the
 * home circle owns its own motion and nothing here draws.
 */
import { actionRowWords, activityLine } from './fleet-tree-copy.js'

const SEC = 1000

/** One pass of the script. The tree then starts its next round. */
export const SAMPLE_SIM_LOOP_MS = 170 * SEC

/** Where a freshly opened page joins the loop: several agents already busy. */
export const SAMPLE_SIM_JOIN_MS = 24 * SEC

/** Every example session id starts with this, and no real one can. */
export const SAMPLE_SIM_SESSION_PREFIX = 'sample-run-'

export const SAMPLE_SIM_TREE_NAME = 'ship the invoice export'

/* THE TREE. One controller, two managers, the builders and a worker under the
 * build manager, and the reviewer, two clerks and an Autonomous+ builder under
 * the release manager: eleven agents, the shape the product's own team runs.
 * Tiers are LAUNCH_TIERS ids (src/orchestration-controls.js) so each circle
 * names a real model family; the suite pins every one to that table. */
export const SAMPLE_SIM_AGENTS = Object.freeze([
  { key: 'controller', role: 'controller', tier: 'sol',
    message: 'Ship the invoice export: readable tables, correct totals, and a review before it lands.' },
  { key: 'build', parent: 'controller', role: 'manager', tier: 'terra',
    message: 'Run the export build: the layout, the totals and the PDF job. Report when all three pass.' },
  { key: 'release', parent: 'controller', role: 'manager', tier: 'claude-opus',
    message: 'Run the release side: review, the ledger clerks, and the open ledger work.' },
  { key: 'layout', parent: 'build', role: 'builder', tier: 'claude-fable',
    message: 'Fix the export layout so long account names wrap inside their column.' },
  { key: 'totals', parent: 'build', role: 'builder', tier: 'luna',
    message: 'Make the totals row add up across page breaks.' },
  { key: 'pdf', parent: 'build', role: 'builder', tier: 'terra',
    message: 'Build the PDF render job. It needs the heavy-job slot.' },
  { key: 'fixtures', parent: 'build', role: 'worker', tier: 'local',
    message: 'Make fixture invoices with long names, long notes and empty sections.' },
  { key: 'reviewer', parent: 'release', role: 'reviewer', tier: 'claude-sonnet',
    message: 'Review each export change, including long notes and empty sections.' },
  { key: 'grok', parent: 'release', role: 'worker', tier: 'grok-4-6',
    message: 'Clerk: file each finished step on the ledger.' },
  { key: 'gemini', parent: 'release', role: 'worker', tier: 'agy-gemini-3-1-pro-high',
    message: 'Clerk: summarise the review notes and watch the Gemini weekly allowance.' },
  { key: 'autoplus', parent: 'release', role: 'builder', tier: 'claude-fable',
    message: 'Autonomous+: finish the CSV column fix, then keep working through the open ledger items.' },
])

/* THE SCRIPT, in seconds from the start of a round. Each agent's beats are its
 * own lane; together they keep the tree busy the whole time. Verbs:
 *   start {message?}   a turn begins (the message is what it was sent)
 *   run                the session is up and working
 *   think  text        a line of reasoning
 *   tool   {...}       a command or tool call, open for `ms`, then its result
 *   wait   text        waiting on something outside the agent
 *   say    {text, ms}  words, streamed over `ms`
 *   finish             the turn ends; its words become the kept reply
 *   limit  {...}       a provider usage limit ends the turn
 *   resume             the automatic retry after a reset
 *   handoff {...}      Keep trying accounts moves it to another sign-in
 *   queue  text        a message waits for the current turn to finish
 *   stop               stopped mid-turn
 *   note   text        the product's own line in the conversation
 *   usage  text        what its sign-in has used, as the usage row says it
 */
const SCRIPT = Object.freeze({
  controller: [
    [0, 'start'], [1.5, 'run'],
    [2, 'think', 'Three parts: the layout, the totals and the PDF job. Review has to see all three before anything lands.'],
    [5, 'tool', { tool: 'Read', detail: 'ledger: open items tagged invoice-export', ms: 1.5, out: '4 open items' }],
    [7.5, 'say', { text: 'Two lanes. The build manager takes the layout, the totals and the PDF job. The release manager runs review, the ledger clerks and the open ledger work.', ms: 5 }],
    [13, 'tool', { tool: 'Task', detail: 'start the build manager and the release manager', ms: 1.2, out: 'both started' }],
    [15, 'wait', 'Waiting for both managers to report.'],
    [64, 'tool', { tool: 'Read', detail: 'build manager: progress report', ms: 1.5, out: 'layout accepted, totals retrying after a usage reset, PDF job on another account' }],
    [66, 'wait', 'Waiting for review to accept all three changes.'],
    [150, 'think', 'All three changes passed review, and the clerks filed each step.'],
    [152, 'say', { text: 'The invoice export is done and reviewed. Long names wrap, totals add up across page breaks, and the PDF job builds in the heavy-job slot.', ms: 5 }],
    [158, 'finish'],
  ],
  build: [
    [8, 'start'], [10, 'run'],
    [11, 'say', { text: 'Taking the build. One builder takes the layout, one the totals and one the PDF job, and a worker makes the fixtures first.', ms: 4 }],
    [15.5, 'tool', { tool: 'Task', detail: 'start three builders and the fixtures worker', ms: 1.2, out: 'four started' }],
    [17.5, 'wait', 'Waiting for the builders.'],
    [45, 'think', 'The totals builder hit a usage limit. It is set to wait for the reset and retry, so nothing needs doing yet.'],
    [47, 'wait', 'Waiting for the builders.'],
    [136, 'tool', { tool: 'Read', detail: 'reports from the layout, totals and PDF builders', ms: 1.5, out: '3 reports, all checks passing' }],
    [138, 'say', { text: 'All three builds pass their checks, and review accepted each one.', ms: 3.5 }],
    [142, 'finish'],
  ],
  release: [
    [9, 'start'], [11, 'run'],
    [12, 'say', { text: 'Release side: the reviewer takes each change as it lands, the clerks file every step, and the Autonomous+ builder works the open ledger items.', ms: 4 }],
    [16.5, 'tool', { tool: 'Task', detail: 'start the reviewer, both clerks and the Autonomous+ builder', ms: 1.2, out: 'four started' }],
    [18.5, 'wait', 'Waiting for the first change to review.'],
    [50, 'tool', { tool: 'Task', detail: 'send the review notes to the layout builder', ms: 1, out: 'delivered' }],
    [52, 'wait', 'Waiting for the fixed change.'],
    [144, 'say', { text: 'Review accepted all three changes and the ledger is up to date.', ms: 3 }],
    [148, 'finish'],
  ],
  fixtures: [
    [17, 'start'], [18.5, 'run'],
    [19, 'tool', { tool: 'Write', detail: 'fixtures/invoices/long-names.json', ms: 1.4 }],
    [21, 'tool', { tool: 'Write', detail: 'fixtures/invoices/empty-sections.json', ms: 1.2 }],
    [23, 'tool', { tool: 'Bash', detail: 'node tools/check-fixtures.mjs', ms: 2.2, out: '12 fixtures, all valid' }],
    [26, 'say', { text: 'Twelve fixture invoices are ready: long names, long notes, and two with empty sections.', ms: 3 }],
    [30, 'finish'],
  ],
  layout: [
    [17, 'start'], [19, 'run'],
    [20, 'think', 'Long names overflow because the name column has no minimum width and never wraps.'],
    [23, 'tool', { tool: 'Grep', detail: 'account-name in src/export', ms: 1.2, out: '3 matches' }],
    [25, 'tool', { tool: 'Read', detail: 'src/export/invoice-table.css', ms: 1 }],
    [27, 'tool', { tool: 'Edit', detail: 'src/export/invoice-table.css (+4 −1)', ms: 1 }],
    [29, 'tool', { tool: 'Bash', detail: 'npm test -- export-layout', ms: 3.5, out: '14 passing' }],
    [33.5, 'say', { text: 'Long account names now wrap inside their column, and the amount column keeps its width. Checked against the long-name fixtures.', ms: 5 }],
    [39, 'finish'],
    [52, 'start', { message: 'Review found a blank header row on empty sections. Hide the header when a section has no lines.' }], [53, 'run'],
    [54, 'think', 'The header is drawn before the section checks whether it has any rows.'],
    [56, 'tool', { tool: 'Read', detail: 'src/export/sections.js', ms: 1 }],
    [58, 'queue', 'When that is done, also check the notes column on the same fixtures.'],
    [59, 'tool', { tool: 'Edit', detail: 'src/export/sections.js (+6 −2)', ms: 1 }],
    [61, 'tool', { tool: 'Bash', detail: 'npm test -- export-sections', ms: 3, out: '9 passing' }],
    [65, 'say', { text: 'Empty sections no longer print a header row; a section with no lines is skipped. Tests pass on the empty-section fixtures.', ms: 4 }],
    [70, 'finish'],
    [71, 'start', { queued: true }], [72, 'run'],
    [73, 'tool', { tool: 'Bash', detail: 'npm test -- export-notes', ms: 3, out: '6 passing' }],
    [77, 'say', { text: 'The notes column wraps correctly on all twelve fixtures. Nothing else needed changing.', ms: 3 }],
    [81, 'finish'],
  ],
  reviewer: [
    [40, 'start', { message: 'Review the layout builder’s change.' }], [41.5, 'run'],
    [42, 'tool', { tool: 'Read', detail: 'diff: src/export/invoice-table.css', ms: 1.5 }],
    [44, 'tool', { tool: 'Bash', detail: 'npm test -- export', ms: 3, out: '31 passing, 1 failing: an empty section prints a blank header row', exit: 1 }],
    [48, 'think', 'Long names wrap, but empty sections still print a blank header row.'],
    [49, 'say', { text: 'Changes requested: long names wrap correctly, but empty sections still print a blank header row. Sending it back to the layout builder.', ms: 4 }],
    [53.5, 'finish'],
    [83, 'start', { message: 'The layout builder fixed the empty sections. Review it again.' }], [84.5, 'run'],
    [85, 'tool', { tool: 'Read', detail: 'diff: src/export/sections.js', ms: 1.2 }],
    [87, 'tool', { tool: 'Bash', detail: 'npm test -- export', ms: 3, out: '32 passing' }],
    [91, 'say', { text: 'Accepted: empty sections are skipped and long names wrap. The layout change can land.', ms: 3.5 }],
    [95, 'finish'],
    [118, 'start', { message: 'Review the totals and PDF changes.' }], [119.5, 'run'],
    [120, 'tool', { tool: 'Read', detail: 'diff: src/export/totals.js, jobs/pdf-render.mjs', ms: 1.5 }],
    [122.5, 'tool', { tool: 'Bash', detail: 'npm test -- export totals pdf', ms: 3, out: '47 passing' }],
    [127, 'say', { text: 'Accepted: totals carry across page breaks, and the PDF job’s output matches the fixtures.', ms: 3.5 }],
    [131, 'finish'],
  ],
  totals: [
    [17.5, 'start'], [19.5, 'run'],
    [20, 'think', 'The totals row is computed per page, so every page break resets the running sum.'],
    [23, 'tool', { tool: 'Read', detail: 'src/export/totals.js', ms: 1 }],
    [25.5, 'tool', { tool: 'Edit', detail: 'src/export/totals.js (+9 −4)', ms: 1 }],
    [28, 'tool', { tool: 'Bash', detail: 'npm test -- export-totals', ms: 3, out: '2 failing: carried total counted twice on the last page', exit: 1 }],
    [32, 'think', 'The carried total is added twice on the last page.'],
    [34, 'limit', { account: 'Work', provider: 'Codex', waitSec: 44 }],
    [78, 'resume'],
    [80, 'tool', { tool: 'Edit', detail: 'src/export/totals.js (+2 −3)', ms: 1 }],
    [82, 'tool', { tool: 'Bash', detail: 'npm test -- export-totals', ms: 2.5, out: '11 passing' }],
    [85.5, 'say', { text: 'Totals now carry across page breaks without counting the last page twice. All totals tests pass.', ms: 4 }],
    [90, 'finish'],
  ],
  pdf: [
    [18, 'start'], [20, 'run'],
    [21, 'say', { text: 'Building the PDF render job. It needs the heavy-job slot, so it waits its turn.', ms: 3 }],
    [24.5, 'tool', { tool: 'Write', detail: 'jobs/pdf-render.mjs', ms: 1.2 }],
    [26, 'wait', 'Waiting for the heavy-job slot. Another build is using it; this job is next.'],
    [44, 'tool', { tool: 'Bash', detail: 'heavy-job: render the 12 fixture invoices', ms: 8, out: '12 PDFs rendered' }],
    [53, 'limit', { account: 'Work', provider: 'Codex', keepTrying: 'Personal' }],
    [55, 'handoff', { from: 'Work', to: 'Personal', provider: 'Codex' }], [57, 'run'],
    [58, 'tool', { tool: 'Read', detail: 'handoff: summary of the last conversation', ms: 1 }],
    [60, 'tool', { tool: 'Bash', detail: 'node jobs/pdf-render.mjs --check', ms: 3, out: '12 of 12 match the fixtures' }],
    [64, 'say', { text: 'The PDF job builds in the heavy-job slot, and all twelve renders match the fixtures.', ms: 4 }],
    [69, 'finish'],
  ],
  grok: [
    [20, 'start'], [21.5, 'run'],
    [22, 'usage', 'Grok usage: not reported. xAI does not publish a remaining allowance for this sign-in, so none is shown.'],
    [23, 'tool', { tool: 'mcp__ledger__file', detail: 'fixtures worker: fixtures ready', ms: 1, out: 'filed #211' }],
    [25, 'say', { text: 'Filed: fixtures ready (#211).', ms: 1.5 }], [27, 'finish'],
    [40, 'start', { message: 'File the layout builder’s change.' }], [41, 'run'],
    [41.5, 'tool', { tool: 'mcp__ledger__file', detail: 'layout builder: change ready for review', ms: 1, out: 'filed #212' }],
    [43, 'say', { text: 'Filed: layout change ready for review (#212).', ms: 1.5 }], [45, 'finish'],
    [54, 'start', { message: 'File the review result.' }], [55, 'run'],
    [55.5, 'tool', { tool: 'mcp__ledger__file', detail: 'reviewer: changes requested on #212', ms: 1, out: 'updated #212' }],
    [57, 'say', { text: 'Filed: review asked for changes; #212 is back with the layout builder.', ms: 1.5 }], [59, 'finish'],
    [96, 'start', { message: 'File the accepted layout change.' }], [97, 'run'],
    [97.5, 'tool', { tool: 'mcp__ledger__file', detail: 'reviewer: accepted #212', ms: 1, out: 'closed #212' }],
    [99, 'say', { text: 'Filed: layout change accepted; #212 closed.', ms: 1.5 }], [101, 'finish'],
    [132, 'start', { message: 'File the totals and PDF results.' }], [133, 'run'],
    [133.5, 'tool', { tool: 'mcp__ledger__file', detail: 'reviewer: accepted #213 and #214', ms: 1, out: 'closed #213, #214' }],
    [135, 'say', { text: 'Filed: totals (#213) and the PDF job (#214) accepted and closed.', ms: 2 }], [138, 'finish'],
  ],
  gemini: [
    [22, 'start'], [23.5, 'run'],
    [24, 'usage', 'Gemini weekly allowance: 38% used, resets Monday. This week’s daily buckets: 6%, 9%, 11%, 12%.'],
    [25, 'tool', { tool: 'Read', detail: 'review notes', ms: 1, out: 'none yet' }],
    [27, 'say', { text: 'Nothing to summarise yet. The first review starts when the layout builder finishes.', ms: 2.5 }], [30, 'finish'],
    [55, 'start', { message: 'Summarise the first review.' }], [56, 'run'],
    [56.5, 'usage', 'Gemini weekly allowance: 39% used, resets Monday.'],
    [57, 'tool', { tool: 'Read', detail: 'reviewer: notes on #212', ms: 1 }],
    [58.5, 'say', { text: 'Summary: the layout fix works for long names, but empty sections still print a blank header. One change requested.', ms: 3.5 }], [62.5, 'finish'],
    [97, 'start', { message: 'Summarise the second review.' }], [98, 'run'],
    [98.5, 'usage', 'Gemini weekly allowance: 41% used, resets Monday.'],
    [99, 'tool', { tool: 'Read', detail: 'reviewer: notes on the fixed #212', ms: 1 }],
    [100.5, 'say', { text: 'Summary: accepted. Empty sections are skipped and long names wrap.', ms: 2.5 }], [103.5, 'finish'],
  ],
  autoplus: [
    [19, 'start'], [21, 'run'],
    [22, 'tool', { tool: 'Read', detail: 'src/export/csv.js', ms: 1 }],
    [24, 'tool', { tool: 'Edit', detail: 'src/export/csv.js (+3 −3)', ms: 1 }],
    [26, 'tool', { tool: 'Bash', detail: 'npm test -- export-csv', ms: 2.5, out: '8 passing' }],
    [29, 'say', { text: 'The CSV columns now follow the table’s order.', ms: 2.5 }], [32, 'finish'],
    [33, 'note', 'Autonomous+ picked up the next open ledger item: #215, add a totals line to the CSV export.'],
    [34, 'start', { message: '#215: add a totals line to the CSV export.' }], [35.5, 'run'],
    [36, 'think', 'The table already computes the totals; the CSV writer just never asks for them.'],
    [38, 'tool', { tool: 'Edit', detail: 'src/export/csv.js (+7 −0)', ms: 1 }],
    [40, 'tool', { tool: 'Bash', detail: 'npm test -- export-csv', ms: 2.5, out: '9 passing' }],
    [43, 'say', { text: 'Added a totals line to the CSV export, using the table’s own totals.', ms: 3 }], [47, 'finish'],
    [48, 'note', 'Autonomous+ picked up the next open ledger item: #216, name the export file after the invoice period.'],
    [49, 'start', { message: '#216: name the export file after the invoice period.' }], [50.5, 'run'],
    [51, 'tool', { tool: 'Read', detail: 'src/export/filename.js', ms: 1 }],
    [53, 'tool', { tool: 'Edit', detail: 'src/export/filename.js (+4 −2)', ms: 1 }],
    [55, 'tool', { tool: 'Bash', detail: 'npm test -- export', ms: 6 }],
    [58, 'stop'],
    [100, 'note', 'Autonomous+ went back to the item it was stopped on: #216.'],
    [101, 'start', { message: '#216: name the export file after the invoice period. Carry on from where you stopped.' }], [102.5, 'run'],
    [103, 'tool', { tool: 'Bash', detail: 'npm test -- export-filename', ms: 3, out: '5 passing' }],
    [107, 'say', { text: 'The export file is now named after the invoice period, for example invoices-2026-08.pdf.', ms: 3.5 }], [111, 'finish'],
  ],
})

/* A small seeded generator (mulberry32). Only token counts and the rhythm of
   streamed words draw from it; the story itself is the fixed table above. */
function prng(seed) {
  let a = (Number(seed) >>> 0) || 1
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const clock = (seconds) => {
  const whole = Math.max(0, Math.ceil(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

/* THE SENTENCES THE PRODUCT ITSELF WOULD SAY for the account events, in its
   own register: what happened, then what happens next. */
export const SAMPLE_SIM_COPY = Object.freeze({
  limitWaiting: ({ account, provider }, left) => `The ${account} account (${provider}) reached its usage limit. Waiting for the reset, then retrying automatically in ${clock(left)}.`,
  /* The conversation keeps the fact, not a clock that would stop in it: the
     countdown lives on the agent's own status line. */
  limitNote: ({ account, provider }) => `The ${account} account (${provider}) reached its usage limit. This turn waits for the reset, then retries by itself.`,
  limitMoving: ({ account, provider, keepTrying }) => `The ${account} account (${provider}) reached its usage limit. Keep trying accounts is on, so this moves to ${keepTrying}.`,
  resumed: ({ account, provider }) => `The ${account} account (${provider}) reset. Retrying the turn automatically.`,
  handoff: ({ from, to, provider }) => `Continued on the ${to} account (${provider}) from a compact handoff of the ${from} conversation. This is a new conversation, not the same one.`,
  queued: text => `Queued until this turn finishes: “${text}”`,
  delivered: 'The queued message was sent when the turn finished.',
  stopped: 'Stopped by you. The ledger item stays open.',
  stoppedNote: 'Stopped by you.',
})

/* The words of one `say`, cut into the pieces a stream delivers. */
function chunks(text, random) {
  const words = String(text).split(' ')
  const out = []
  for (let i = 0; i < words.length;) {
    const take = 1 + Math.floor(random() * 3)
    out.push(words.slice(i, i + take).join(' '))
    i += take
  }
  return out
}

/* THE SCRIPT, COMPILED: every beat with an absolute time and an agent key,
   countdowns expanded to one beat per second, words cut into stream pieces and
   every tool call paired with its result. Sorted, so a round is one walk. */
export function compileSampleScript({ seed = 1 } = {}) {
  const random = prng(seed)
  const beats = []
  let order = 0
  const push = (at, key, verb, arg) => beats.push({ at: Math.round(at * SEC), key, verb, arg, order: order++ })
  for (const agent of SAMPLE_SIM_AGENTS) {
    let toolSeq = 0
    for (const [at, verb, arg] of SCRIPT[agent.key] || []) {
      if (verb === 'say') {
        const pieces = chunks(arg.text, random)
        const step = (arg.ms || 3) / Math.max(1, pieces.length)
        let text = ''
        pieces.forEach((piece, index) => {
          text = text ? `${text} ${piece}` : piece
          push(at + step * index, agent.key, 'words', text)
        })
      } else if (verb === 'tool') {
        const id = `${agent.key}-${++toolSeq}`
        push(at, agent.key, 'tool', { ...arg, id })
        push(at + (arg.ms || 1), agent.key, 'tool-done', { ...arg, id })
      } else if (verb === 'limit' && Number.isFinite(arg.waitSec)) {
        push(at, agent.key, 'limit', arg)
        for (let left = arg.waitSec - 1; left > 0; left -= 1) push(at + (arg.waitSec - left), agent.key, 'countdown', { ...arg, left })
      } else {
        push(at, agent.key, verb, arg)
      }
    }
  }
  return beats.sort((a, b) => (a.at - b.at) || (a.order - b.order))
}

/**
 * Add the working tree to an example store, every agent a draft. Returns the
 * tree id and the node id minted for each script key, or null when the store
 * refused (a defect in this file's data, left for the suite to catch).
 */
export function seedSampleSimTree(store) {
  const made = store.createTree({ name: SAMPLE_SIM_TREE_NAME })
  const treeId = made?.tree?.id ?? made?.id ?? null
  if (!treeId) return null
  const ids = new Map()
  for (const agent of SAMPLE_SIM_AGENTS) {
    const parentId = agent.parent ? ids.get(agent.parent) ?? null : null
    const added = store.addNode({ treeId, parentId, role: agent.role, tier: agent.tier, message: agent.message })
    const nodeId = added?.node?.id ?? added?.id ?? null
    if (!nodeId) return null
    ids.set(agent.key, nodeId)
  }
  return { treeId, ids }
}

/* A history row in the shape the chat paints (see actionChatRow in
   src/views/computers.js). The words come from the product's own vocabulary,
   so an example row reads exactly like a real one. */
function actionRow({ id, tool, detail, out = '', exit = 0 }, state, at) {
  const words = actionRowWords({ tool, detail, state })
  const result = state === 'working' ? '' : out || (exit ? `exit code ${exit}` : '')
  return {
    who: 'action', id: `action:${SAMPLE_SIM_SESSION_PREFIX}${id}`,
    tool: words.tool, detail: words.detail, state: words.state, stateKey: state,
    body: [detail, result].filter(Boolean).join('\n\n'),
    at,
  }
}

/* What the canvas chip says an agent is doing, in the product's own words. */
function cardLine({ tool, detail }) {
  if (tool === 'Bash') return activityLine({ kind: 'call', command: detail })
  if (tool === 'Edit' || tool === 'Write') return activityLine({ kind: 'call', tool: 'fileChange' })
  return activityLine({ kind: 'call', tool })
}

const HISTORY_CAP = 80

/**
 * Play the script over an example store seeded by seedSampleSimTree.
 *
 * `advance(nowMs)` applies every beat that fell due since the last call -- to
 * the store (statuses, sessions and replies, through its own API) and to the
 * plain per-agent picture this keeps -- and answers with the events the page
 * should draw. Nothing runs by itself: there are no timers here, so a hidden
 * page costs nothing and a test drives the clock by hand.
 *
 * Events: status (repaint the tree), activity (repaint one agent's chip),
 * owner (a message sent to the agent), turn-open / words / turn-close (its
 * reply, streamed), row (a tool call or its result), thinking, note (the
 * product's own line in the conversation), round (a new pass began).
 */
export function createSampleFleetRun({ store, seeded, seed = 1, startedAt = Date.now(), joinAtMs = SAMPLE_SIM_JOIN_MS } = {}) {
  if (!store || !seeded?.ids) throw new Error('createSampleFleetRun needs the example store and its seed')
  const beats = compileSampleScript({ seed })
  const random = prng(seed * 7919)
  const origin = startedAt - joinAtMs
  const liveSessions = new Set()
  const problems = []
  const agents = new Map(SAMPLE_SIM_AGENTS.map(agent => [agent.key, {
    key: agent.key, brief: agent.message, nodeId: seeded.ids.get(agent.key), conversation: 1, sessionId: null,
    history: [], streaming: '', streamAt: null, tool: '', thinking: '', usage: '', queued: [], limit: null, tokens: 0,
  }]))
  const byNode = new Map([...agents.values()].map(agent => [agent.nodeId, agent]))
  let round = 0
  let cursor = 0
  let clockMs = -1

  const sessionFor = agent => `${SAMPLE_SIM_SESSION_PREFIX}${agent.key}-${agent.conversation}`
  const keep = (label, result) => {
    if (result && result.ok === false) problems.push(`${label}: ${(result.problems || []).join(' ') || 'refused'}`)
    return result
  }
  const remember = (agent, entry) => {
    agent.history.push(entry)
    if (agent.history.length > HISTORY_CAP) agent.history.splice(0, agent.history.length - HISTORY_CAP)
  }

  function attach(agent) {
    const node = store.getNode(agent.nodeId)
    const sessionId = sessionFor(agent)
    if (node?.sessionId !== sessionId) {
      if (node?.sessionId) keep(`${agent.key} detach`, store.detachSession(agent.nodeId))
      keep(`${agent.key} attach`, store.attachSession(agent.nodeId, sessionId))
    }
    agent.sessionId = sessionId
    liveSessions.add(sessionId)
  }
  /* A TURN THAT IS OVER LETS GO OF ITS SESSION. The store keeps the status,
     the note and the reply (a finished agent's history does not need a live
     session to stay true), and the page then treats it as the session-less
     example it is -- so no finished example agent ever offers a door that
     leads to a real one. */
  function release(agent) {
    const node = store.getNode(agent.nodeId)
    if (node?.sessionId) keep(`${agent.key} detach`, store.detachSession(agent.nodeId))
    if (agent.sessionId) liveSessions.delete(agent.sessionId)
    agent.sessionId = null
  }
  function status(agent, next, note = '') {
    keep(`${agent.key} ${next}`, store.setNodeStatus(agent.nodeId, next, { note }))
  }

  function apply(beat, at, events) {
    const agent = agents.get(beat.key)
    if (!agent?.nodeId || !store.getNode(agent.nodeId)) return
    const { verb, arg } = beat
    const nodeId = agent.nodeId
    const changed = () => events.push({ kind: 'status', nodeId })
    const row = entry => {
      const index = agent.history.findIndex(item => item.who === 'action' && item.id === entry.id)
      if (index >= 0) agent.history[index] = entry
      else remember(agent, entry)
      events.push({ kind: 'row', nodeId, row: entry })
    }
    const note = text => {
      remember(agent, { who: 'note', text, at })
      events.push({ kind: 'note', nodeId, text, at })
    }
    const closeStream = () => {
      if (agent.streamAt === null) return ''
      const text = agent.streaming
      if (text) remember(agent, { who: 'agent', text, at })
      events.push({ kind: 'turn-close', nodeId, text })
      agent.streaming = ''
      agent.streamAt = null
      return text
    }
    const openStream = () => {
      agent.streamAt = at
      agent.streaming = ''
      events.push({ kind: 'turn-open', nodeId, at })
    }

    if (verb === 'start') {
      const message = arg?.queued ? agent.queued.shift() : arg?.message || (agent.history.length ? null : agent.brief)
      if (message) {
        remember(agent, { who: 'you', text: message, at })
        events.push({ kind: 'owner', nodeId, text: message, at })
      }
      if (arg?.queued) note(SAMPLE_SIM_COPY.delivered)
      attach(agent)
      status(agent, 'starting')
      agent.tool = ''
      agent.thinking = ''
      changed()
    } else if (verb === 'run') {
      if (!agent.sessionId) attach(agent)
      status(agent, 'running')
      openStream()
      changed()
    } else if (verb === 'think') {
      agent.thinking = arg
      events.push({ kind: 'thinking', nodeId, text: arg, at })
    } else if (verb === 'tool') {
      agent.tool = cardLine(arg)
      row(actionRow(arg, 'working', at))
    } else if (verb === 'tool-done') {
      agent.tool = activityLine({ kind: 'result', exitCode: arg.exit || 0 })
      row(actionRow(arg, arg.exit ? 'undone' : 'done', at))
    } else if (verb === 'wait') {
      agent.tool = arg
      events.push({ kind: 'activity', nodeId })
    } else if (verb === 'words') {
      if (agent.streamAt === null) openStream()
      agent.streaming = arg
      agent.tokens += 3 + Math.floor(random() * 5)
      events.push({ kind: 'words', nodeId, text: arg })
    } else if (verb === 'finish') {
      const said = closeStream()
      if (said) keep(`${agent.key} reply`, store.setNodeReply(nodeId, said))
      status(agent, 'finished')
      release(agent)
      agent.tool = ''
      agent.thinking = ''
      changed()
    } else if (verb === 'limit') {
      closeStream()
      agent.limit = arg
      const sentence = arg.keepTrying ? SAMPLE_SIM_COPY.limitMoving(arg) : SAMPLE_SIM_COPY.limitWaiting(arg, arg.waitSec)
      status(agent, 'turn-failed', sentence)
      note(arg.keepTrying ? sentence : SAMPLE_SIM_COPY.limitNote(arg))
      agent.tool = ''
      changed()
    } else if (verb === 'countdown') {
      status(agent, 'turn-failed', SAMPLE_SIM_COPY.limitWaiting(arg, arg.left))
      events.push({ kind: 'activity', nodeId })
    } else if (verb === 'resume') {
      note(SAMPLE_SIM_COPY.resumed(agent.limit || { account: 'Work', provider: 'Codex' }))
      status(agent, 'running')
      agent.limit = null
      openStream()
      changed()
    } else if (verb === 'handoff') {
      release(agent)
      agent.conversation += 1
      const sentence = SAMPLE_SIM_COPY.handoff(arg)
      attach(agent)
      status(agent, 'starting', sentence)
      note(sentence)
      agent.limit = null
      changed()
    } else if (verb === 'queue') {
      agent.queued.push(arg)
      note(SAMPLE_SIM_COPY.queued(arg))
      events.push({ kind: 'activity', nodeId })
    } else if (verb === 'stop') {
      closeStream()
      for (const entry of agent.history.slice()) {
        if (entry.who === 'action' && entry.stateKey === 'working') {
          row({ ...entry, state: actionRowWords({ state: 'undone' }).state, stateKey: 'undone' })
        }
      }
      note(SAMPLE_SIM_COPY.stopped)
      status(agent, 'interrupted', SAMPLE_SIM_COPY.stoppedNote)
      release(agent)
      agent.tool = ''
      agent.thinking = ''
      changed()
    } else if (verb === 'note') {
      note(arg)
      status(agent, store.getNode(nodeId).status, arg)
      changed()
    } else if (verb === 'usage') {
      agent.usage = arg
      note(arg)
    }
  }

  /* A NEW ROUND is the controller being sent the job again: every agent keeps
     its last status and reply, so the tree reads as having done the work, and
     each conversation starts over from its brief. */
  function nextRound() {
    round += 1
    cursor = 0
    for (const agent of agents.values()) {
      agent.history = []
      agent.streaming = ''
      agent.streamAt = null
      agent.queued = []
      agent.limit = null
    }
  }

  function advance(nowMs = Date.now()) {
    const events = []
    const target = nowMs - origin
    while (clockMs < target) {
      const roundStart = round * SAMPLE_SIM_LOOP_MS
      const stepTo = Math.min(target, roundStart + SAMPLE_SIM_LOOP_MS)
      const local = stepTo - roundStart
      while (cursor < beats.length && beats[cursor].at <= local) {
        const beat = beats[cursor++]
        apply(beat, origin + roundStart + beat.at, events)
      }
      clockMs = stepTo
      if (stepTo >= roundStart + SAMPLE_SIM_LOOP_MS) {
        nextRound()
        events.push({ kind: 'round', round })
      }
    }
    return events
  }

  return Object.freeze({
    advance,
    liveSessions,
    problems,
    round: () => round,
    /** The per-agent picture the canvas and the rail draw from. */
    viewOf(nodeId) {
      const agent = byNode.get(nodeId)
      if (!agent) return null
      return {
        tool: agent.tool, thinking: agent.thinking, usage: agent.usage, tokens: agent.tokens,
        streaming: agent.streamAt === null ? null : agent.streaming,
        sessionId: agent.sessionId, queued: agent.queued.slice(),
      }
    },
    /** The conversation so far, for a chat opened in the middle of it. */
    historyOf(nodeId) {
      const agent = byNode.get(nodeId)
      return agent ? agent.history.slice() : null
    },
    owns: nodeId => byNode.has(nodeId),
  })
}

/** Is this an example session id (and therefore never a real one)? */
export function isSampleSimSession(sessionId) {
  return typeof sessionId === 'string' && sessionId.startsWith(SAMPLE_SIM_SESSION_PREFIX)
}
