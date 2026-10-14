/* THE WHOLE WORLD OF THE PREVIEW, GENERATED FROM ONE FIXED SEED.
 *
 * No backend, no fetch, no credential, no file. Every name, number and line of
 * transcript below is produced by the seeded generator in this file, which is
 * why the preview can promise a visitor that nothing on the page is a reading.
 *
 * NO OWNER DATA, BY CONSTRUCTION. There are no hostnames, no IP addresses, no
 * account names, no repository paths and no model bills from any real fleet.
 * The two hosts are called what a stranger would call their own two computers.
 * Earlier product simulations shipped one particular fleet's roster — down to
 * its migration plan — to every install; that is the failure this file is
 * written not to repeat. tools/check-no-owner-data.mjs is run over this
 * directory and its exit code is recorded in the lane verdict.
 *
 * VOCABULARY IS CURATED. No string here may use a word from the liveness
 * lexicon defined in honesty.js, because a transcript line that asserts a
 * working link to something is a claim about reality even when the line itself
 * was invented. tools/check-preview-honesty.mjs fails the build on one, and it
 * scans this file rather than trusting the rule to be remembered.
 */

/** Deterministic 32-bit PRNG (mulberry32). Same seed, same preview, every visit
 *  and every machine — which also means the screenshots in the lane verdict are
 *  reproducible rather than a lucky frame. */
export function seeded(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const SEED = 20260811

const ROLES = Object.freeze({
  coordinator: { id: 'coordinator', label: 'coordinator', hex: '#008dab' },
  helper: { id: 'helper', label: 'helper', hex: '#c85900' },
  shadow: { id: 'shadow', label: 'reviewer', hex: '#00956c' },
  manager: { id: 'manager', label: 'manager', hex: '#3e63f0' },
  default: { id: 'default', label: 'worker', hex: '#9d7900' },
})

export const ROLE_LIST = Object.freeze(Object.values(ROLES))

/* The capabilities this preview is allowed to describe. This is a CLOSED list
 * and honesty.js assertUnpaid() refuses anything outside it — including the
 * engine's one gated capability, which honesty.js names in PAID_GATED and which
 * is deliberately absent from this list: the owner's shape for this preview is
 * the product, not the paid services. */
export const PREVIEW_CAPABILITIES = Object.freeze([
  Object.freeze({
    id: 'fleet-view',
    title: 'Every agent on every computer, in one tree',
    body: 'Each computer you own becomes a branch. Each agent it is running becomes a node, '
      + 'coloured by the job it was given. Open any node to see what that agent has been doing.',
  }),
  Object.freeze({
    id: 'agent-drill-in',
    title: 'Read an agent, not a log file',
    body: 'Its task, its model, how long it has been going, what it has done and what it asked for — '
      + 'in a page you can read, with the controls to stop or redirect it in the same place.',
  }),
  Object.freeze({
    id: 'approvals',
    title: 'Nothing reaches your machine without your yes',
    body: 'When an agent needs to do something that touches the outside world it stops and asks. '
      + 'You approve or refuse. No answer is not an answer: an unanswered request stays refused.',
  }),
  Object.freeze({
    id: 'audit-ledger',
    title: 'A record you can check, not a record you must trust',
    body: 'Every decision is written into a hash-chained ledger. Change one entry and the chain '
      + 'stops verifying, so the record can be checked by you rather than believed.',
  }),
  Object.freeze({
    id: 'spend-metrics',
    title: 'What it cost, before the bill',
    body: 'Tokens and spend per agent, per computer and per day, with a cap you set. '
      + 'The cap is enforced where the spending happens, not printed on a dashboard.',
  }),
  Object.freeze({
    id: 'local-first',
    title: 'It runs on your computers',
    body: 'The product is a desktop application. Install it and it works, with no account, '
      + 'no subscription and no network — for as long as you want.',
  }),
])

export const PREVIEW_CAPABILITY_IDS = Object.freeze(PREVIEW_CAPABILITIES.map(c => c.id))

const TASK_LINES = Object.freeze([
  'summarise the four proposals into one page',
  'find every place the old rate is still hard-coded',
  'rewrite the import script to stream instead of buffer',
  'draft the release notes from the merged branches',
  'check the invoices against the spreadsheet',
  'convert the scanned pages into searchable text',
  'trim the test suite down to what still runs',
  'sort the photo archive by the date in the file',
  'reconcile the two address books',
  'produce a chart of last quarter from the raw export',
])

const TRANSCRIPT_LINES = Object.freeze([
  'Read 14 files under the reports folder.',
  'Found three copies of the same helper; kept the one with tests.',
  'The second spreadsheet has a header row the first one does not.',
  'Wrote a draft to notes/summary.md and left the original untouched.',
  'Asking before touching anything outside the project folder.',
  'Two of the ten rows failed to parse; both are listed rather than dropped.',
  'Finished the pass. 6 changes proposed, none applied yet.',
  'Stopping here: the next step needs permission that has not been given.',
  'Re-ran the check after the edit; it passes.',
  'That path does not exist, so nothing was written.',
])

const REQUEST_LINES = Object.freeze([
  { id: 'rq-1', what: 'Write to notes/summary.md', why: 'to save the draft it just produced', scope: 'one file, inside the project folder' },
  { id: 'rq-2', what: 'Read the spreadsheets folder', why: 'to reconcile the two address books', scope: 'read only, 12 files' },
  { id: 'rq-3', what: 'Install a PDF text extractor', why: 'the scanned pages cannot be read without one', scope: 'one package, from the public index' },
])

const AGENT_NAMES = Object.freeze([
  'planner', 'reader', 'editor', 'checker', 'sorter', 'drafter', 'indexer', 'packer',
])

/** Build the whole simulated world. Pure and deterministic. */
export function buildWorld(seed = SEED) {
  const rnd = seeded(seed)
  const pick = list => list[Math.floor(rnd() * list.length) % list.length]

  const hosts = [
    { id: 'h1', name: 'Desktop', note: 'the computer this window is open on' },
    { id: 'h2', name: 'Laptop', note: 'a second computer you also own' },
  ]

  let n = 0
  const agents = []
  for (const host of hosts) {
    const coordinator = {
      id: `${host.id}-a${++n}`, host: host.id, parent: null,
      name: host.id === 'h1' ? 'coordinator' : 'coordinator-2',
      role: 'coordinator', model: 'a large model', ageMin: 74 + Math.floor(rnd() * 40),
      state: 'simulated-working', task: 'hold the plan and hand work out',
      done: 18 + Math.floor(rnd() * 9),
    }
    agents.push(coordinator)

    const managerCount = host.id === 'h1' ? 2 : 1
    const managers = []
    for (let m = 0; m < managerCount; m += 1) {
      const manager = {
        id: `${host.id}-a${++n}`, host: host.id, parent: coordinator.id,
        name: m === 0 ? 'manager' : 'manager-2', role: 'manager', model: 'a large model',
        ageMin: 41 + Math.floor(rnd() * 30), state: 'simulated-working',
        task: pick(TASK_LINES), done: 7 + Math.floor(rnd() * 8),
      }
      managers.push(manager)
      agents.push(manager)
    }

    const reviewer = {
      id: `${host.id}-a${++n}`, host: host.id, parent: coordinator.id,
      name: 'reviewer', role: 'shadow', model: 'a small model',
      ageMin: 33 + Math.floor(rnd() * 20), state: 'simulated-waiting',
      task: 'check the work before it is handed back', done: 4 + Math.floor(rnd() * 5),
    }
    agents.push(reviewer)

    const workerCount = host.id === 'h1' ? 4 : 3
    for (let w = 0; w < workerCount; w += 1) {
      const parent = managers[w % managers.length]
      agents.push({
        id: `${host.id}-a${++n}`, host: host.id, parent: parent.id,
        name: `${pick(AGENT_NAMES)}-${w + 1}`, role: w === 0 ? 'helper' : 'default',
        model: w % 2 === 0 ? 'a small model' : 'a large model',
        ageMin: 3 + Math.floor(rnd() * 26),
        state: w === workerCount - 1 ? 'simulated-blocked' : 'simulated-working',
        task: pick(TASK_LINES), done: Math.floor(rnd() * 6),
      })
    }
  }

  const transcript = Array.from({ length: 7 }, (_, i) => ({
    id: `t${i}`, agent: agents[(i * 3 + 2) % agents.length].name, text: TRANSCRIPT_LINES[i % TRANSCRIPT_LINES.length],
    minutesAgo: 2 + i * 3,
  }))

  const requests = REQUEST_LINES.map(r => ({ ...r, decision: null }))

  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  const spend = days.map((day, i) => ({
    day,
    tokensK: 40 + Math.floor(rnd() * 120) + i * 6,
    costCents: 120 + Math.floor(rnd() * 260),
  }))

  const ledger = [
    { id: 'L-001', kind: 'decision', text: 'Refused: reach a host outside the project folder', chain: 'a41f' },
    { id: 'L-002', kind: 'run', text: 'Agent "reader" finished a task in 4 minutes', chain: '7c02' },
    { id: 'L-003', kind: 'cap', text: 'Daily spend cap set to a value you choose', chain: 'be59' },
  ]

  return { hosts, agents, transcript, requests, spend, ledger, capabilities: PREVIEW_CAPABILITIES }
}

export const ROLE_HEX = Object.freeze(
  Object.fromEntries(Object.values(ROLES).map(r => [r.id, r.hex])),
)
export const ROLE_LABEL = Object.freeze(
  Object.fromEntries(Object.values(ROLES).map(r => [r.id, r.label])),
)

/** One step of the world's clock. Deterministic in the tick index, so the
 *  simulation moves without ever inventing a number that depends on the wall
 *  clock — a preview that drifts with the visitor's clock is a preview whose
 *  screenshots cannot be reproduced. */
export function advance(world, tick) {
  const rnd = seeded(SEED + tick * 7919)
  const next = { ...world, agents: world.agents.map(a => ({ ...a })), transcript: world.transcript.slice() }
  const cycle = ['simulated-working', 'simulated-waiting', 'simulated-working', 'simulated-blocked', 'simulated-finished']
  for (const agent of next.agents) {
    if (agent.role === 'coordinator') continue
    if (rnd() < 0.22) {
      agent.state = cycle[(cycle.indexOf(agent.state) + 1) % cycle.length]
      if (agent.state === 'simulated-finished') agent.done += 1
    }
    agent.ageMin += 1
  }
  if (tick % 3 === 0) {
    const speaker = next.agents[Math.floor(rnd() * next.agents.length)]
    next.transcript = [
      { id: `t-${tick}`, agent: speaker.name, text: TRANSCRIPT_LINES[tick % TRANSCRIPT_LINES.length], minutesAgo: 1 },
      ...next.transcript.slice(0, 6).map(line => ({ ...line, minutesAgo: line.minutesAgo + 1 })),
    ]
  }
  return next
}
