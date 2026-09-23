// FIRST-RUN CONTENT IS A PROFILE, NOT A PRODUCT CONSTANT.
//
// This product grew out of one person's two-machine fleet, and the shipped
// build carried the SHAPE of that fleet as its seed data: a retired
// "compatibility host" beside a "canonical" one, the real durable-memory board
// keys, the real request ledger, the real account aliases, the real transport
// ports. The byte-level ship gate (tools/check-no-owner-data.mjs) cannot see
// any of it — none of it is his name, his username, his paths or his LAN. It
// is the SHAPE that identifies, and a stranger opening the app was reading
// somebody else's world with no way to know that is what it was.
//
// So everything site-specific now lives in one record, with two copies of it:
//
//   SHIPPED  SAMPLE_PROFILE below. Deliberately, visibly a sample: every board
//            key is `sample/…`, every evidence path is `sample/…`, the pinned
//            first message says so in words, and no transport is configured.
//            A stranger must never have to wonder whether they are looking at
//            real activity belonging to someone else.
//
//   OWNER    private/fleet-profile.owner.json — the original fleet, verbatim.
//            It sits outside public/ and outside build.files (`dist/**`,
//            `shell/**`), so neither vite nor electron-builder can pack it,
//            which is the same split public/data/research-queue.json and
//            private/research-queue.authored.json already use.
//
// Resolution is SYNCHRONOUS on purpose. src/sim.js builds the fleet during
// module evaluation and eight modules import the result, so an async profile
// would leave half the app on the old roster. The desktop shell therefore
// supplies its userData copy through a synchronous, narrow preload bootstrap;
// localStorage remains the browser fallback and the migration path for the
// owner's existing profile.

const STORAGE_KEY = 'mc.fleet.profile'
export const FLEET_PROFILE_STORAGE_KEY = STORAGE_KEY

/* Hosts carry RFC 5737 documentation addresses (192.0.2.0/24) ON PURPOSE:
   they can never resolve to a real machine. Do NOT "improve" them into a
   realistic-looking private range like 192.168.x — that ships something that
   reads as a real machine roster while still passing a grep for the owner's
   own address, which is the bug this replaced. `note` says what each host IS,
   and for the sample the honest answer is that it is a sample. */
const SAMPLE_MACHINES = [
  { id: 'c1', name: 'Computer 1', short: '1', ip: '192.0.2.1', note: 'sample host', ageHours: 20 },
  { id: 'c2', name: 'Computer 2', short: '2', ip: '192.0.2.2', note: 'sample host', ageHours: 9 },
]

/* Transports are the operator's own infrastructure, so the sample declares the
   two lanes the product knows how to show and configures neither. `port: null`
   renders as "not configured" rather than as a green light over a port number
   nobody chose — a fresh install claiming a live relay is the same class of
   lie as shipping someone else's roster. */
const SAMPLE_TRANSPORTS = [
  { id: 'relay', label: 'relay', port: null, note: 'not configured' },
  { id: 'tools', label: 'tool lane', port: null, note: 'not configured' },
]

/* Account pools are the operator's own accounts, and a pool record now carries
   its own card copy. It did not: src/views/metrics.js decided what a pool card
   said from its INDEX — pool 0 was a subscription seat, pool 1 a vendor credit
   balance, anything else a dormant single-sign-on account held behind a named
   MFA product. That is one person's account taxonomy asserted about whatever
   pools happen to be loaded, so the strings moved here where a profile can
   replace them.

   `meter` decides how the card and the burn panel read the pool: 'percent' is
   a resetting quota, 'currency' a depleting balance, 'dormant' an account with
   no compute attached (no burn row, no runway). `stats` fills the card's two
   right-hand cells, and {pct} interpolates the used percentage.

   The ids are short by design: they print as the account name on the card and
   as the sankey's pool node, and the widest tooltip in the app is built from
   one (see the viewportTooltip note in metrics.js). */
const SAMPLE_POOLS = [
  { id: 'sample-a', kind: 'Sample pool', desc: 'sample account · seat quota',
    meter: 'percent', burnLabel: 'sample seat', burnWindow: 'quota window, resets monthly',
    caption: 'seat quota', stats: ['{pct}% of seat', '2 surfaces'], tipKind: 'seat quota',
    color: '#008dab', glow: '#45d6ff' },
  { id: 'sample-b', kind: 'Sample pool', desc: 'sample account · prepaid credit',
    meter: 'currency', burnLabel: 'sample credit',
    caption: null, stats: ['no expiry set', 'worker lanes'], tipKind: 'prepaid credit',
    color: '#3e63f0', glow: '#7d9bff' },
  { id: 'sample-c', kind: 'Sample pool', desc: 'sample account · no compute attached',
    meter: 'dormant',
    caption: 'attached, not spending', stats: ['no window', 'no compute'], tipKind: 'dormant account',
    color: '#00956c', glow: '#35eab7' },
]

/* Task and feed lines describe what an agent fleet DOES — claims, phases,
   checkpoints, leases — and nothing about where it runs. The set they replaced
   named this product's own internal services, stores, instruction files and
   inboxes, which told a stranger about a system they cannot see. */
const SAMPLE_TASKS = [
  'Claim the next queued task', 'Reconcile open gates', 'Retry a failed step',
  'Refresh a stale cache entry', 'Re-run checks after a handoff', 'Audit connection health',
  'Promote a verified change', 'Verify the tool profile', 'Regenerate the capability digest',
  'Sweep unclaimed task leases', 'Checkpoint a long-running phase', 'Cross-check the host table',
  'Validate assignment recency', 'Flush buffered audit records', 'Verify the signed audit chain',
  'Re-point a stale test', 'Index the message channels', 'Answer a pending question',
  'Confirm the stop switch is clear', 'Rebuild the tool allowlist', 'Measure cache savings',
  'Archive a finished plan', 'Split the queue into slices', 'Verify workspace isolation',
  'Escalate a stale heartbeat',
]

const SAMPLE_FEED = [
  'indexing the message channels', 'running checks from the workspace root',
  'polling the question queue', 'probing the relay lane',
  'probing the tool lane', 'verifying the host handshake',
  'regenerating the tool digest', 're-reading assignments before acting',
  'checking for open gates', 'claiming a task lease',
  'heartbeating before the next checkpoint', 'writing status to durable storage',
  'scanning recent sessions for claims', 'comparing declared and connected servers',
  'reading its role assignment', 'spot-verifying claims against live files',
  'promoting an entry after a freshness check', 'sweeping stale leases from the queue',
  'flushing buffered audit records', 'verifying the audit chain at the latest sequence',
  'checking the stop switch before sending', 'resolving an assignment tie by date',
  'recording a checkpoint before the phase ends', 're-reading the plan after a phase',
  'watching heartbeat freshness', 'matching a workspace against the host table',
  'searching the board for open questions', 'answering a question at its reply key',
  'staging a refresh for a stale entry', 'treating a truncated run as a continuation',
]

const SAMPLE_CHAT = [
  { from: 'them', text: 'claim the next phase; name your files; report evidence, not intent' },
  { from: 'me', text: 'claimed — checks clean, no colliding session, starting the sweep' },
  { from: 'them', text: 'verdict: ACCEPT, 17 checks pass; wire it up' },
  { from: 'me', text: 'fix round posted: the rejected item is addressed, nothing else moved' },
  { from: 'them', text: 'check both lanes independently before you call either one healthy' },
  { from: 'me', text: 'both lanes answered; evidence is in the status probe' },
  { from: 'them', text: 'a truncated run is a continuation, not a completion — checkpoint and resume' },
  { from: 'me', text: 'checkpointed at phase 3 of 5; resuming after the plan re-read' },
  { from: 'them', text: 'a gate is open on this class; hold the send until it clears' },
  { from: 'me', text: 'held until the gate cleared, then sent; receipt logged' },
]

const SAMPLE_CHAT_REPLIES = [
  'ack — evidence is on the board at the reply key',
  'verdict: ACCEPT, 12 checks pass, 41s wall clock',
  'checks clean, no colliding claim; proceeding',
  'checkpointed; resuming after the plan re-read',
  'lease heartbeat fresh; phase 2 of 4 underway',
  'read-only sweep done; 3 entries promoted, 1 staged',
  'holding at the fence; the gate is unmet',
  'two worker lanes started; territories do not overlap',
]

const SAMPLE_CHAT_CONTEXT_REPLIES = {
  coordinator: [
    'assignment read — {{context}}. gates stay closed until the evidence clears; no territory changes from this thread.',
    'coordination pass: {{context}}. the current owners stay in place and I am watching for the next revision.',
    'ack — {{context}}. nothing collides with the named territory, so the lane continues behind its existing fence.',
    'gate check: {{context}}. nothing goes out until the register says clear, then I log the receipt.',
    'territory is stable. {{context}}. if that changes I issue one bounded handoff rather than splitting ownership.',
    'the current assignment is accounted for: {{context}}. the next checkpoint waits on evidence, not on elapsed time.',
    'fleet read: {{context}}. no stale claim is being treated as live; I reconcile before assigning again.',
    'holding the coordination line — {{context}}. owners, gates and open questions stay on separate tracks.',
    'revision checked: {{context}}. the active phase stays fenced; a truncation would checkpoint and resume, never close it.',
    'coordinator answer: {{context}}. I keep the lane scoped and raise only a real decision.',
  ],
  lane: [
    'current lane — {{context}}. the sweep is moving; nothing stuck and no drift out of territory.',
    'working the current item: {{context}}. evidence goes back when the bounded pass closes.',
    'ack — {{context}}. the next check is queued behind this one; replies stay serialized.',
    'current task: {{context}}. heartbeat is fresh, the fence is intact, and I am continuing.',
    'status from {{agent}}: {{context}}. nothing to report as a blocker; the next checkpoint is the natural stop.',
    'still in the same lane — {{context}}. I have not crossed into adjacent files or opened a second phase.',
    'read-only pass first: {{context}}. if the evidence holds I promote it; otherwise it stays staged.',
    'checkpoint view: {{context}}. progress is real, but I am not calling it complete before the last check.',
    'on it — {{context}}. one task, one stream, then the queued turn gets the line.',
    'lane update: {{context}}. no lease contention, no hidden retry, and nothing waiting on a decision.',
  ],
}

/* Channel keys are `sample/…` so that every topic bar, every watch-board box
   header and every rail tooltip on the page says what the data is. The keys
   they replaced were the real durable-memory addresses of a working fleet,
   documented in this file's own comment as "the real stable keys". */
const SAMPLE_CHANNELS = [
  { id: 'notices', name: 'notices', key: 'sample/notices', mach: '1·2', pinned: true,
    topic: 'sample board — demonstration traffic, not a live fleet' },
  { id: 'assignments', name: 'assignments', key: 'sample/assignments', mach: '1·2',
    topic: 'sample assignments — newest revision wins' },
  { id: 'status', name: 'status', key: 'sample/status', mach: '1·2',
    topic: 'sample status packets — claims, phases, checkpoints, heartbeats' },
  { id: 'blockers', name: 'blockers', key: 'sample/blockers', mach: '1·2',
    topic: 'sample stop-the-line notices' },
  { id: 'reviews', name: 'reviews', key: 'sample/reviews', mach: '1',
    topic: 'sample review verdicts — ACCEPT / REJECT with an evidence path' },
  { id: 'questions', name: 'questions', key: 'sample/questions', mach: '2',
    topic: 'sample questions — answers arrive at the reply key' },
]

/* Seeded board history. `agoH` is hours before load, so every stamp is in the
   past and the log opens with real scrollback and day dividers.

   These lines are SHORT, and that is a reversal of the previous set's stated
   goal. That set was written to read as genuine — 56 hours of curated traffic,
   full-packet register, no line repeated — because the aim then was for the
   demo to be indistinguishable from a real board. That aim is exactly the
   defect now: sample data that reads as real activity is sample data a
   stranger will mistake for someone's real activity. Plain, plainly-generic
   lines are the requirement, not a shortcut. */
const SAMPLE_BOARD = {
  notices: [
    { agoH: 30, s: 'assistant', pinned: true, t: 'This board is sample data shipped with the app. Nothing here was sent by anyone. Connect a fleet host, or load a saved profile, to see real traffic in its place.' },
    { agoH: 29.4, s: 'controller', t: 'sample notice: channel keys on this board all start with sample/ so the demonstration data is always distinguishable from a live board.' },
    { agoH: 24.1, s: 'assistant', t: 'sample notice: no transport is configured in this profile, so the lanes below the channel list read as not configured rather than as up.' },
    { agoH: 18.6, s: 'controller', t: 'sample notice: agents, machines and accounts on this board are placeholders. None of them correspond to a real host or a real account.' },
    { agoH: 9.2, s: 'assistant', t: 'sample notice: the live views read from a local fleet host. With no host detected they report that plainly instead of falling back to this data.' },
    { agoH: 2.4, s: 'controller', t: 'sample notice: everything on this page can be replaced by loading your own profile. The sample stays available as the demonstration.' },
  ],
  assignments: [
    { agoH: 28.7, s: 'controller', t: 'sample assignment: the checks lane is the priority this round. Cosmetic work waits until the gates read green.' },
    { agoH: 28.5, s: 'codexb', t: 'ack on the second host; two seats claimed.' },
    { agoH: 22.0, s: 'controller', t: 'sample assignment: evidence paths are required in every packet. A bare "done" is rejected unread.' },
    { agoH: 21.8, s: 'luna', t: 'ack; the packet template is updated.' },
    { agoH: 12.5, s: 'controller', t: 'sample assignment: territories are file-disjoint this round. Touching another lane\'s file is an automatic hand-back.' },
    { agoH: 12.3, s: 'gem2', t: 'ack; territory re-read before claiming.' },
    { agoH: 3.1, s: 'controller', t: 'sample assignment: fix rounds address the rejected item only. A wider diff reopens the whole review.' },
  ],
  status: [
    { agoH: 27.9, s: 'luna', t: 'claim: seat 1, the checks pass. No colliding claim; territory named file by file.' },
    { agoH: 27.6, s: 'gem2', t: 'claim: seat 2, the cross-check. Territory is disjoint from seat 1.' },
    { agoH: 25.2, s: 'gem2', t: 'phase 1 complete — 9 of 9 checks pass in 41s. Evidence: sample/evidence/cross-check.md' },
    { agoH: 20.4, s: 'sandbox', t: 'checkpoint at phase 1 of 4; resume state written.' },
    { agoH: 15.8, s: 'luna', t: 'lease heartbeat fresh; phase 3 of 4 underway.' },
    { agoH: 8.3, s: 'gem4', t: 'phase 2 complete — 18 of 18 checks pass in 1m26s. Evidence: sample/evidence/phase-2.md' },
    { agoH: 1.7, s: 'sandbox', t: 'phase 3 complete — 17 of 17 checks pass in 1m04s. Evidence: sample/evidence/phase-3.md' },
    { agoH: 0.4, s: 'luna', t: 'lease heartbeat fresh; phase 4 of 5 underway.' },
  ],
  blockers: [
    { agoH: 26.5, s: 'luna', t: 'BLOCKER: a stale lease is holding the queue lock — the heartbeat is 40 minutes old. Sweeping it before the claim.' },
    { agoH: 26.2, s: 'luna', t: 'cleared — lease swept, lock released, eight minutes lost.' },
    { agoH: 19.1, s: 'assistant', t: 'collision warning: two lanes named the same file. The later claim yields and re-claims after the first checkpoint.' },
    { agoH: 18.8, s: 'gem2', t: 'yielding the file; my edit rebases onto theirs.' },
    { agoH: 10.6, s: 'gem4', t: 'BLOCKER: one lane probe timed out; the other stayed clean. Verifying the two independently before calling it an outage.' },
    { agoH: 10.1, s: 'gem4', t: 'cleared — the retry answered in 210ms; both lanes healthy.' },
    { agoH: 2.0, s: 'assistant', t: 'watchdog: all leases fresh, no stale locks, board clean.' },
  ],
  reviews: [
    { agoH: 29.0, s: 'terra', t: 'sample/reviews/1: ACCEPT — 12 of 12 criteria pass, 33s. Every path in the evidence tree resolves.' },
    { agoH: 23.4, s: 'terra', t: 'sample/reviews/2: REJECT — criterion 2 fails: the check skips deleted entries, so the clean verdict was unearned. One fix round, that criterion only.' },
    { agoH: 22.6, s: 'terra', t: 're-review of 2: ACCEPT — the missing case is covered, 11 of 11 pass.' },
    { agoH: 14.2, s: 'terra', t: 'sample/reviews/3: ACCEPT — 15 of 15 criteria pass, 47s.' },
    { agoH: 7.5, s: 'terra', t: 'sample/reviews/4: REJECT — criterion 4 fails: the focus ring never paints on the third control. Scoped to that criterion.' },
    { agoH: 1.2, s: 'terra', t: 'queue note: two lanes are waiting on captures; verdicts follow in claim order.' },
  ],
  questions: [
    { agoH: 28.2, s: 'gem2', t: 'question: where do evidence files belong — the reports tree or the artifacts tree?' },
    { agoH: 27.9, s: 'controller', t: 'answered at the reply key: reports for lane evidence, artifacts for review verdicts.' },
    { agoH: 16.4, s: 'sandbox', t: 'question: does a heartbeat on my own lease count as a write while the fence is read-only?' },
    { agoH: 16.1, s: 'helperb', t: 'answered at the reply key: your own liveness is fine; the fence covers the shared surface.' },
    { agoH: 5.8, s: 'gem4', t: 'question: who owns the shared stylesheet this round? I need one token added.' },
    { agoH: 5.5, s: 'controller', t: 'answered at the reply key: request the token from its owner. A one-line edit to a shared file is still a fence break.' },
  ],
}

/* Watch-board conversations. Ten lines per side is not decoration: the bag
   draw in comms.js partitions each side's pool into recent and non-recent
   halves, and its worst-case spacing guarantee is (pool − recent) side-draws
   with recent fixed at 4. Shorten a pool below ten and the two halves stop
   being halves, and the repeat the partition exists to prevent comes back. */
const SAMPLE_CONVERSATIONS = [
  {
    id: 'fleet-sync', a: 'controller', b: 'codexb', key: 'sample/fleet-sync', child: 'work-brief',
    desc: 'sample conversation — cross-host sync',
    lines: {
      a: [
        'assignments are mirrored to both hosts; fan your lanes out after the ack.',
        'the gate sweep is clean here: 9 of 9 re-verified, no disputes.',
        'hold new lanes until the open fix round lands.',
        'the relay probe answered from this side; take the tool lane on yours.',
        'the territory map is re-pinned. Every lane is file-disjoint this round.',
        'the question queue is drained: three items, all informational.',
        'restating ownership for the new lanes before anyone claims.',
        'do not answer on the owner\'s behalf; surface the question and hold.',
        'the map is authority, not memory — re-read it before every claim.',
        'if the two hosts disagree on a revision, stop and raise it here first.',
      ],
      b: [
        'ack — the revision matches here. Four seats claimed, territories named.',
        'the tool lane answered in 210ms; with your relay result both are green.',
        'checks came back clean: no colliding sessions, no stale claims.',
        'host identity confirmed mechanically rather than from memory.',
        'swept a stale lease off the queue; the seat behind it re-claimed cleanly.',
        'mirror check done: both hosts read the same revision, byte for byte.',
        'question queue drained here: one ack, two status packets, no replies owed.',
        'holding new lanes as asked; two are queued and can start within a phase.',
        're-read the map before the last two claims. Both are still disjoint.',
        'one lease looked live in my view but was stale when I checked directly.',
      ],
    },
  },
  {
    id: 'work-brief', a: 'controller', b: 'luna', key: 'sample/work-brief', child: 'lane-detail',
    desc: 'sample conversation — assignment and packets',
    lines: {
      a: [
        'the lane is yours. Name your files in the claim itself.',
        'the consistency pass is blocking: any two pages must read as one product.',
        'fix rounds address rejected items only — no opportunistic refactors.',
        'visual evidence is captures at both test sizes, every time.',
        'checkpoint before the phase ends, not after you hit the fence.',
        'name the files exactly; the next lane routes around your claim.',
        'a green build is not evidence. Exercise the route and say what you saw.',
        'if a criterion cannot be measured, rewrite it until a number falls out.',
        'flag early if the long phase runs over. I would rather re-fence than rush.',
        'route the packet through status and stop while the verdict is out.',
      ],
      b: [
        'claimed. Checks clean, territory named as two files and nothing else.',
        'phase 3 complete: 41 of 41 pass in 2m18s, no flakes across three runs.',
        'checkpoint written at phase 4 of 5 with the resume state attached.',
        'lease heartbeat fresh. The reorder pass is underway.',
        're-read the territory map before claiming, as directed.',
        'exercised every route after the build rather than trusting the render.',
        'the packet carries an evidence path for every claim in it.',
        'stopping at the fence with phase 5 open rather than half-landed.',
        'one deviation to flag: I took the extra space from a local token.',
        'timing note: the first phases came in under estimate, this one is over.',
      ],
    },
  },
  {
    id: 'lane-detail', a: 'luna', b: 'sandbox', key: 'sample/lane-detail', child: null,
    desc: 'sample conversation — worker brief',
    lines: {
      a: [
        'take the seat; the failing path gets its test written first.',
        'keep stored values under the size ceiling and split anything close.',
        'report evidence, not intent. Verdict, numbers, paths, in that order.',
        'snapshot inside the window only, and restore before it closes.',
        'start at the step that has been flaking rather than at the top.',
        'twenty runs minimum before you call the flake narrowed.',
        'do not widen the seat to chase the bug into another lane\'s files.',
        'ask here before sweeping shared state; the window costs others nothing.',
        'prune your artifacts as you go — the quota is shared.',
        'when the seat closes, the reproduction goes in the packet, not a summary.',
      ],
      b: [
        'seat claimed. The flake reproduces once in twenty runs on a cold start.',
        'it is deterministic now: 20 of 20 fail the same way from a cold start.',
        'artifacts pruned to the last five runs; the quota is back to 40% free.',
        'checkpoint at phase 2 of 4; the snapshot restored against its checksum.',
        'my largest value is close to the ceiling, so I am splitting it now.',
        'confirmed: the failing path is the one that never guarded the empty case.',
        'the snapshot was taken inside the window and nothing was read after it.',
        'seat released. The reproduction is replayable from the packet.',
        'two early runs hit the shared quota; both are marked tainted, not deleted.',
        'asked for the window here rather than sweeping the state myself.',
      ],
    },
  },
  {
    id: 'review', a: 'terra', b: 'gem2', key: 'sample/review', child: 'fix-round',
    desc: 'sample conversation — review verdicts',
    lines: {
      a: [
        'pre-read done: scope confirmed, three evidence paths spot-checked.',
        'REJECT on one criterion: the measured value misses the floor.',
        're-review queued. I re-check the failed criterion only.',
        'the capture rig stays pinned to both sizes through the whole queue.',
        'ACCEPT — 17 of 17 criteria pass and every path I pulled resolves.',
        'a screenshot is not a measurement. Show me the reading, not the picture.',
        'I read the diff against the charter, not against your last packet.',
        'the evidence is thin for the smaller size. Attach a current run.',
        'one fix round means one. A miss reopens the review in full.',
        'queue status: this one is at the front, two more behind it.',
      ],
      b: [
        'hand-back ready: the value is raised and verified by probe at both sizes.',
        'evidence is attached with the probe output inline, not described.',
        're-review requested. The diff touches the two files named in the claim.',
        'added a check to my lane list so this class of miss stops recurring.',
        'the smaller capture is re-run; the stale one is deleted, not superseded.',
        'withdrawing that criterion rather than defending it — it was eyeballed.',
        'the diff is 41 lines including comments; the shared file is untouched.',
        're-run timing: 38s, no flake across 20 iterations.',
        'the criterion wording moved between revisions; I built against the newer.',
        'holding my side open until the verdict lands. The branch is frozen.',
      ],
    },
  },
  {
    id: 'fix-round', a: 'luna', b: 'gem2', key: 'sample/fix-round', child: null,
    desc: 'sample conversation — one round to answer a rejection',
    lines: {
      a: [
        'scope the fix to the rejected criterion and leave the shared files alone.',
        'verify at both sizes before the hand-back goes up, and verify by probe.',
        'route the packet through the hand-back key and nothing else.',
        'no opportunistic refactors in a fix round, however untidy the neighbours.',
        'the packet answers the rejection, not the neighbourhood around it.',
        'if a second criterion breaks while you fix the first, say so immediately.',
        'the reviewer sees the diff before the summary. Write for that order.',
        'if the shared component has to move, that is a request, not this round.',
        'measure off the rendered box, not off the stylesheet value.',
        'the hand-back closes the round; anything pushed after it opens a new one.',
      ],
      b: [
        'the shared component is untouched — I diffed it to prove it to myself.',
        'both sizes re-captured after the fix; the floor holds at both.',
        'hand-back posted with the measurement, the scoped diff and the captures.',
        'computed off the rendered box as instructed; the two disagreed by a pixel.',
        'the diff stays inside the named files and the packet carries the stat.',
        'caught myself about to reuse a stale measurement and re-measured instead.',
        'the round stays open on my side until the verdict lands. Nothing pushed.',
        'final scope: one file, four lines, including the comment explaining why.',
        'held the hand-back until the second size was measured rather than posting early.',
        're-ran the full sweep locally; nothing else regressed under the fix.',
      ],
    },
  },
  {
    id: 'status-roll', a: 'luna', b: 'gem4', key: 'sample/status-roll', child: null,
    desc: 'sample conversation — status roll-up',
    lines: {
      a: [
        'roll-up is due at the next checkpoint from every open lane.',
        'ran the collision check ahead of your phase; nothing adjacent is claimed.',
        'heartbeat before you sleep. Two quiet intervals and the lease is swept.',
        'a truncated run is a continuation — resume it, do not re-claim it fresh.',
        'if the packet cannot name its evidence, it is not ready. Hold it.',
        'plan long operations around the sweep interval and say so in the claim.',
        'the roll-up is due whether the phase closed or not. Say which it is.',
        'name your territory in the claim, not in a note somewhere else.',
        'evidence paths in every packet, resolvable at the time you post.',
        'if the fence lands mid-work, checkpoint and stop. Do not race it.',
      ],
      b: [
        'lease heartbeat fresh. Phase 2 of 3 underway; the dry run passed.',
        'checkpoint written with the file list and the command to continue.',
        'checks show no colliding claim on any of my three files.',
        'territory claimed on two files, both named and both unclaimed elsewhere.',
        'resumed from the checkpoint cleanly — nothing re-run, no drift.',
        'roll-up posted: two phases closed, one fenced mid-work with a checkpoint.',
        'swept my own stale lease from the last wake before claiming fresh.',
        'the phase hit the fence mid-work, so I checkpointed rather than racing it.',
        'every evidence path was opened and read back before posting.',
        'nothing to report this interval; posting the nothing so the sweep sees life.',
      ],
    },
  },
]

/* The sample register doubles as the setup path. A generic ledger of somebody
   else's engineering work still reads as somebody else's activity; a register
   about connecting THIS install cannot, and it answers the question a first
   run actually raises. Evidence paths stay under sample/ so an expanded row
   says what it is. */
const SAMPLE_REQUESTS = [
  { id: 'R1', title: 'Connect this install to a fleet host', status: 'in-progress', agent: 'codex', ageHours: 3.3, gate: 'LOCAL-WORK', evidence: 'sample/evidence/host-connect.md', claimedAt: '17:08:12Z' },
  { id: 'R1.1', parent: 'R1', title: 'Detect a local agent host', status: 'done', agent: 'claude', ageHours: 4.1, evidence: 'sample/evidence/host-detect.txt', claimedAt: '16:19:44Z' },
  { id: 'R1.2', parent: 'R1', title: 'Confirm each projection reports a source', status: 'open', agent: 'terra-01', ageHours: 0.9, evidence: 'sample/evidence/projection-source.txt', claimedAt: '—' },
  { id: 'R1.3', parent: 'R1', title: 'Choose which views read live data', status: 'open', agent: 'luna-02', ageHours: 0.6, evidence: 'sample/evidence/live-view-flags.md', claimedAt: '—' },

  { id: 'R2', title: 'Describe your machines in a fleet profile', status: 'in-progress', agent: 'luna-02', ageHours: 9.2, evidence: 'sample/evidence/profile-draft.json', claimedAt: '14:02:51Z' },
  { id: 'R2.1', parent: 'R2', title: 'Name each host and give it an address', status: 'done', agent: 'sandbox-w1', ageHours: 20.5, evidence: 'sample/evidence/hosts.json', claimedAt: '14:17:03Z' },
  { id: 'R2.2', parent: 'R2', title: 'Declare the transports the fleet uses', status: 'in-progress', agent: 'gem-lane-4', ageHours: 6.2, gate: 'LOCAL-WORK', evidence: 'sample/evidence/transports.json', claimedAt: '14:14:09Z' },
  { id: 'R2.2.1', parent: 'R2.2', title: 'Leave a transport unset until it is real', status: 'open', agent: 'terra-01', ageHours: 0.3, evidence: 'sample/evidence/unset-transport.md', claimedAt: '—' },
  { id: 'R2.3', parent: 'R2', title: 'Replace the sample board with your own keys', status: 'open', agent: 'gem-lane-2', ageHours: 0.4, evidence: 'sample/evidence/board-keys.md', claimedAt: '—' },

  { id: 'R3', title: 'Decide what the fleet may do without asking', status: 'blocked', agent: 'codex', ageHours: 27.0, gate: 'IRREVERSIBLE', evidence: 'sample/evidence/gate-policy.md', claimedAt: '11:22:14Z' },
  { id: 'R3.1', parent: 'R3', title: 'List the actions that always need a decision', status: 'done', agent: 'claude', ageHours: 8.7, evidence: 'sample/evidence/gated-actions.md', claimedAt: '11:43:26Z' },
  { id: 'R3.2', parent: 'R3', title: 'Set the stop switch and verify it is clear', status: 'gated', agent: 'sandbox-w1', ageHours: 1.4, gate: 'OUTWARD', evidence: 'sample/evidence/stop-switch.txt', claimedAt: '19:04:02Z' },

  { id: 'R4', title: 'Point the app at your own request register', status: 'open', agent: 'sandbox-w1', ageHours: 50.0, evidence: 'sample/evidence/register-source.md', claimedAt: '—' },
  { id: 'R5', title: 'Set the retention window for stored samples', status: 'in-progress', agent: 'gem-lane-4', ageHours: 7.6, gate: 'LOCAL-WORK', evidence: 'sample/evidence/retention.md', claimedAt: '12:51:28Z' },
  { id: 'R6', title: 'Review what leaves the computer you are driving before enabling sends', status: 'gated', agent: 'codex', ageHours: 0.8, gate: 'OUTWARD', evidence: 'sample/evidence/outward-review.md', claimedAt: '19:39:11Z' },
]

const SAMPLE_QUESTIONS = [
  { id: 'Q1', question: 'Which machines should this install treat as one fleet?', status: 'pending', agent: 'codex', ageHours: 3.1, evidence: 'sample/questions/Q1.json', claimedAt: '17:19:31Z' },
  { id: 'Q2', question: 'Should idle lanes be reaped automatically, or held for review?', status: 'answered', answer: 'Reap them automatically; a held lane that nobody reviews reads as live and is not.', agent: 'terra-01', ageHours: 33.0, evidence: 'sample/questions/Q2-answer.json', claimedAt: '12:27:44Z' },
  { id: 'Q3', question: 'Do the two transport lanes belong in one combined health figure?', status: 'answered', answer: 'No; show them separately, because either can fail while the other stays green.', agent: 'claude', ageHours: 49.0, evidence: 'sample/questions/Q3-answer.json', claimedAt: '09:46:18Z' },
  { id: 'Q4', question: 'May a reviewer accept a criterion from a screenshot alone?', status: 'pending', agent: 'terra-01', ageHours: 1.0, evidence: 'sample/questions/Q4.json', claimedAt: '19:27:16Z' },
  { id: 'Q5', question: 'How long should a lease survive without a heartbeat?', status: 'pending', agent: 'luna-02', ageHours: 1.9, evidence: 'sample/questions/Q5.json', claimedAt: '18:33:05Z' },
  { id: 'Q6', question: 'Should stale entries stay visible while a refresh is staged?', status: 'answered', answer: 'Yes; mark them stale and keep them visible until the verified replacement lands.', agent: 'gem-lane-3', ageHours: 61.0, evidence: 'sample/questions/Q6-answer.json', claimedAt: '09:18:40Z' },
  { id: 'Q7', question: 'Which actions may never run without a decision first?', status: 'pending', agent: 'gem-lane-4', ageHours: 0.7, evidence: 'sample/questions/Q7.json', claimedAt: '19:42:50Z' },
  { id: 'Q8', question: 'Does every answer need a receipt written back to the board?', status: 'pending', agent: 'codex', ageHours: 0.5, evidence: 'sample/questions/Q8.json', claimedAt: '19:54:32Z' },
]

/* THE HOME SESSION IS THE HARDEST SAMPLE IN THE APP, because a transcript
   reads as an exchange between real people in a way a channel log does not.
   The set this replaced was a written morning from one real fleet: its owner
   asking about a link outage, its coordinator answering with two port numbers,
   a named canonical checkout, real board keys, and an owner decision about
   retiring a real host — the whole of it inside the shipped bundle and on the
   first screen a stranger sees.

   Two things make this version a demonstration instead of a recording. The
   subject is the interface itself: every turn is about what this view shows
   and how to replace it, which no transcript of somebody's working day would
   be. And the notice sits at the END, not the top — the log opens pinned to
   the newest turn, so a first-time reader reads the last lines first, and a
   banner at the top would be scrolled out of sight before anyone saw it. */
const SAMPLE_SPEAKERS = {
  owner: { cls: 'is-owner', label: 'owner' },
  claude: { cls: 'is-coord', label: 'claude · coordinator', hue: 'var(--c-coordinator)' },
  codex: { cls: 'is-coord', label: 'codex · coordinator', hue: 'var(--c-coordinator)' },
  'codex-b': { cls: 'is-agent', label: 'codex-b', hue: 'var(--c-coordinator)' },
  'luna-02': { cls: 'is-agent', label: 'luna-02', hue: 'var(--c-manager)' },
  'terra-01': { cls: 'is-agent', label: 'terra-01', hue: 'var(--c-shadow)' },
  'gem-lane-3': { cls: 'is-agent', label: 'gem-lane-3', hue: 'var(--c-default)' },
  'sandbox-w1': { cls: 'is-agent', label: 'sandbox-w1', hue: 'var(--c-default)' },
  act: { cls: 'is-act', label: '' },
}

const SAMPLE_SESSION = [
  { who: 'act', text: 'sample transcript loaded — no fleet host connected; nothing in this thread was sent by anyone' },
  { who: 'owner', text: 'What am I looking at?' },
  { who: 'codex', text: 'A demonstration of this view. The ring above reads a real health sweep from a local fleet host, and with no host connected it says so rather than showing a number. Everything between the braces is sample content shipped with the app.' },
  { who: 'owner', text: 'So none of these agents exist.' },
  { who: 'codex', text: 'None of them. The roster, the machines, the accounts and this conversation are placeholders from the sample profile. Load a profile of your own and every one of them is replaced.' },
  { who: 'act', text: 'read sample profile — 2 hosts · 3 accounts · 6 channels · 6 conversations' },
  { who: 'owner', text: 'Show me what a working thread looks like.' },
  { who: 'codex', text: 'The lines below are the register a real session uses: a lane claims work and names its files, it reports phases with numbers and an evidence path, a reviewer accepts or rejects one criterion at a time, and quiet tool lines mark what actually ran.' },
  { who: 'luna-02', text: 'claim: the checks lane — no colliding claim, territory named file by file. phase 1 of 3 underway, checkpoint before the fence.' },
  { who: 'gem-lane-3', text: 'fix scoped to the one rejected criterion; the shared component is untouched. measured off the rendered box rather than the stylesheet. hand-back posted.' },
  { who: 'act', text: 'sample/evidence/handback-9.md written — 412 characters · lease heartbeat fresh' },
  { who: 'terra-01', text: 're-review: ACCEPT — 11 of 11 criteria pass, 38s. every path in the evidence tree resolves. evidence: sample/evidence/review-9.md' },
  { who: 'codex', text: 'One round, closed. That is the shape the register exists for: a claim, a measurement, a verdict, and a path somebody else can walk without asking a question.' },
  { who: 'owner', text: 'And when I connect something real?' },
  { who: 'codex', text: 'Switch a view to its live source in settings and it reads the local projection instead of this. If no host answers, that view says so plainly — it never falls back to the sample and lets you read placeholder traffic as real.' },
  { who: 'act', text: 'sample transcript ends here — the composer below still answers, from the same sample' },
]

const SAMPLE_ARRIVALS = [
  { who: 'luna-02', text: 'phase 2 complete — 18 of 18 checks pass, 1m26s. evidence: sample/evidence/phase-2.md' },
  { who: 'terra-01', text: 'sample/reviews/5: ACCEPT — 15 of 15 criteria pass, 52s. evidence tree complete.' },
  { who: 'codex', text: 'Roll-up: every lease fresh, no open blockers, one verdict queued. Sample readings throughout.' },
  { who: 'gem-lane-3', text: 'checkpoint at phase 4 of 5 — resuming after the plan re-read. nothing re-run.' },
  { who: 'act', text: 'lease sweep — four sample lanes active, all heartbeats fresh, no stale locks' },
  { who: 'sandbox-w1', text: 'sample backfill 3 of 9 posted — no lane left without an evidence path.' },
  { who: 'act', text: 'sample/evidence/roll-up.md written — 388 characters' },
  { who: 'codex', text: 'Nothing here needs a decision. The sample never asks for one — it only shows where one would land.' },
  { who: 'luna-02', text: 'lane released — nothing held past the sample wave.' },
  { who: 'act', text: 'sample transport check — none configured on this install' },
]

const SAMPLE_REPLIES = [
  'Noted. On a connected fleet this would go to the board and both hosts would ack it; here it stops at the sample.',
  'Checks first, then the territory gets scoped and the files named in the claim, so nothing collides.',
  'Every lease fresh, no open blockers, one verdict queued. Sample readings, but that is the shape of the answer.',
  'That one needs a decision at a gate, so it holds rather than guessing — a deadline never outranks the register.',
  'Flagged for a sweep. The evidence packet would name whatever it found, including nothing.',
  'Delegated with the territory scoped to two files. One fix round; a second failure escalates instead of retrying.',
  'The honest answer is mid-phase — checkpointed and resumable. Better landed clean than called done early.',
  'Recorded with an evidence path. A bare "done" would not survive a review anyway.',
]

const SAMPLE_REPLY_ACTS = [
  'checked the sample roster — no colliding claim',
  'sample register — 3 open gates, none blocking a lane',
  'read sample/notices — nothing new since the last read',
  'sample transports — none configured on this install',
]

export const SAMPLE_PROFILE = Object.freeze({
  schemaVersion: 1,
  id: 'sample',
  label: 'Sample fleet',
  machines: SAMPLE_MACHINES,
  transports: SAMPLE_TRANSPORTS,
  /* Named for what they measure, not for one vendor's product and one kind of
     account: these were vertexRemaining / vertexTotal / subSeatPct / uniPct,
     and the values were a real balance to the cent. */
  spend: { creditRemaining: 180, creditTotal: 300, seatPct: 60, dormantPct: 5 },
  pools: SAMPLE_POOLS,
  tasks: SAMPLE_TASKS,
  feed: SAMPLE_FEED,
  chat: SAMPLE_CHAT,
  chatReplies: SAMPLE_CHAT_REPLIES,
  chatContextReplies: SAMPLE_CHAT_CONTEXT_REPLIES,
  channels: SAMPLE_CHANNELS,
  board: SAMPLE_BOARD,
  conversations: SAMPLE_CONVERSATIONS,
  ledger: { requests: SAMPLE_REQUESTS, questions: SAMPLE_QUESTIONS },
  speakers: SAMPLE_SPEAKERS,
  session: SAMPLE_SESSION,
  arrivals: SAMPLE_ARRIVALS,
  replies: SAMPLE_REPLIES,
  replyActs: SAMPLE_REPLY_ACTS,
  sessionTitle: 'sample transcript · demonstration of this view',
  composerTarget: 'codex',
})

/* The original resolver accepted any non-empty section and silently borrowed
   the rest from SAMPLE_PROFILE. That made `{ id: 'mine' }` look configured
   while every visible machine, message, account and ledger row still belonged
   to the demonstration. Resolution now has one explicit verdict: malformed
   profiles fall back ATOMICALLY to the visibly labelled sample and carry an
   error the UI cannot discard; valid partial v1 profiles name every section
   that is still demonstration data. */
const PROFILE_MAX_BYTES = 2 * 1024 * 1024
const PROFILE_ARRAY_SECTIONS = ['machines', 'transports', 'pools', 'tasks', 'feed', 'chat', 'chatReplies',
  'channels', 'conversations', 'session', 'arrivals', 'replies', 'replyActs']
const PROFILE_OBJECT_SECTIONS = ['spend', 'chatContextReplies', 'board', 'speakers']
const PROFILE_TEXT_SECTIONS = ['sessionTitle', 'composerTarget']
const PROFILE_INHERITABLE_SECTIONS = [
  'spend', 'pools', 'tasks', 'feed', 'chat', 'chatReplies', 'chatContextReplies',
  'channels', 'board', 'conversations', 'ledger', 'speakers', 'session',
  'arrivals', 'replies', 'replyActs', 'sessionTitle', 'composerTarget',
]

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const nonEmptyText = value => typeof value === 'string' && Boolean(value.trim())
const finiteNumber = value => typeof value === 'number' && Number.isFinite(value)
const safeIdentifier = value => nonEmptyText(value) && value.length <= 128 && /^[a-z0-9][a-z0-9._:/-]*$/i.test(value)
const safeMarkupCopy = value => typeof value === 'string' && !/[<>\u0000-\u001f]/.test(value)
const safeCssClass = value => typeof value === 'string' && /^[a-z_][a-z0-9_-]*(?:\s+[a-z_][a-z0-9_-]*)*$/i.test(value)
const safeHue = value => typeof value === 'string' && /^(?:#[0-9a-f]{3,8}|var\(--[a-z0-9-]+\))$/i.test(value)
const profileError = (path, message, source = 'profile') => Object.freeze({ path, message, source })

function jsonBytes(text) {
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(text).byteLength
  return String(text).length
}

function validateMachine(machine, index, errors, ids) {
  const path = `machines[${index}]`
  if (!isPlainObject(machine)) {
    errors.push(profileError(path, 'must be an object'))
    return
  }
  if (!safeIdentifier(machine.id)) errors.push(profileError(`${path}.id`, 'must be a safe identifier'))
  else if (ids.has(machine.id)) errors.push(profileError(`${path}.id`, `duplicates ${machine.id}`))
  else ids.add(machine.id)
  if (!nonEmptyText(machine.name)) errors.push(profileError(`${path}.name`, 'is required'))
  else if (!safeMarkupCopy(machine.name)) errors.push(profileError(`${path}.name`, 'contains unsafe markup characters'))
  if (machine.short !== undefined && !safeMarkupCopy(machine.short)) errors.push(profileError(`${path}.short`, 'contains unsafe markup characters'))
  const address = nonEmptyText(machine.ip) ? machine.ip : machine.address
  if (!nonEmptyText(address)) {
    errors.push(profileError(`${path}.ip`, 'address is required'))
  } else if (address.length > 2048) {
    errors.push(profileError(`${path}.ip`, 'is too long'))
  } else if (address.includes('\0')) {
    errors.push(profileError(`${path}.ip`, 'cannot contain a NUL character'))
  } else {
    try {
      const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(address) ? address : `tcp://${address}`)
      if (parsed.username || parsed.password) errors.push(profileError(`${path}.ip`, 'must not contain credentials'))
    } catch {
      /* Bare IPv6 addresses are valid machine identities even though URL
         parsing requires brackets. Reachability stays explicitly unverified
         until a probeable port is supplied. */
      if (!/^[0-9a-f:]+$/i.test(address)) errors.push(profileError(`${path}.ip`, 'is not a valid host, IP address, or URL'))
    }
  }
}

function validateTransport(transport, index, errors, ids) {
  const path = `transports[${index}]`
  if (!isPlainObject(transport)) {
    errors.push(profileError(path, 'must be an object'))
    return
  }
  if (!safeIdentifier(transport.id)) errors.push(profileError(`${path}.id`, 'must be a safe identifier'))
  else if (ids.has(transport.id)) errors.push(profileError(`${path}.id`, `duplicates ${transport.id}`))
  else ids.add(transport.id)
  if (transport.endpoint != null && typeof transport.endpoint !== 'string') {
    errors.push(profileError(`${path}.endpoint`, 'must be text when present'))
  } else if (typeof transport.endpoint === 'string' && transport.endpoint.length > 2048) {
    errors.push(profileError(`${path}.endpoint`, 'is too long'))
  } else if (typeof transport.endpoint === 'string' && transport.endpoint.includes('\0')) {
    errors.push(profileError(`${path}.endpoint`, 'cannot contain a NUL character'))
  } else if (nonEmptyText(transport.endpoint)) {
    try {
      const endpoint = transport.endpoint.trim()
      const legacyPort = /^:(\d+)$/.exec(endpoint)
      const parsed = legacyPort
        ? new URL(`tcp://localhost:${legacyPort[1]}`)
        : new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(endpoint) ? endpoint : `tcp://${endpoint}`)
      if (!parsed.hostname) errors.push(profileError(`${path}.endpoint`, 'must include a host'))
      if (parsed.username || parsed.password) errors.push(profileError(`${path}.endpoint`, 'must not contain credentials'))
    } catch {
      errors.push(profileError(`${path}.endpoint`, 'is not a valid URL or host:port'))
    }
  }
  if (transport.port !== null && transport.port !== undefined) {
    const port = Number(transport.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      errors.push(profileError(`${path}.port`, 'must be null or an integer from 1 through 65535'))
    }
  }
}

function validateStringArray(value, path, errors, { nonEmpty = false } = {}) {
  if (!Array.isArray(value)) {
    errors.push(profileError(path, 'must be an array'))
    return
  }
  if (nonEmpty && value.length === 0) errors.push(profileError(path, 'must contain at least one entry'))
  value.forEach((entry, index) => {
    if (!nonEmptyText(entry)) errors.push(profileError(`${path}[${index}]`, 'must be non-empty text'))
  })
}

function validateContentSections(candidate, errors) {
  if (hasOwn(candidate, 'spend')) {
    if (!isPlainObject(candidate.spend)) errors.push(profileError('spend', 'must be an object'))
    else for (const key of ['creditRemaining', 'creditTotal', 'seatPct', 'dormantPct']) {
      if (!finiteNumber(candidate.spend[key])) errors.push(profileError(`spend.${key}`, 'must be a finite number'))
    }
  }

  if (Array.isArray(candidate.pools)) {
    const ids = new Set()
    candidate.pools.forEach((pool, index) => {
      const path = `pools[${index}]`
      if (!isPlainObject(pool)) { errors.push(profileError(path, 'must be an object')); return }
      if (!safeIdentifier(pool.id)) errors.push(profileError(`${path}.id`, 'must be a safe identifier'))
      else if (ids.has(pool.id)) errors.push(profileError(`${path}.id`, `duplicates ${pool.id}`))
      else ids.add(pool.id)
      if (!nonEmptyText(pool.kind)) errors.push(profileError(`${path}.kind`, 'is required'))
      else if (!safeMarkupCopy(pool.kind)) errors.push(profileError(`${path}.kind`, 'contains unsafe markup characters'))
      if (!nonEmptyText(pool.desc)) errors.push(profileError(`${path}.desc`, 'is required'))
      else if (!safeMarkupCopy(pool.desc)) errors.push(profileError(`${path}.desc`, 'contains unsafe markup characters'))
      if (pool.tipKind !== undefined && !safeMarkupCopy(pool.tipKind)) errors.push(profileError(`${path}.tipKind`, 'contains unsafe markup characters'))
      if (!['percent', 'currency', 'dormant'].includes(pool.meter)) {
        errors.push(profileError(`${path}.meter`, 'must be percent, currency, or dormant'))
      }
    })
  }

  if (hasOwn(candidate, 'tasks')) validateStringArray(candidate.tasks, 'tasks', errors, { nonEmpty: true })
  if (hasOwn(candidate, 'feed')) validateStringArray(candidate.feed, 'feed', errors, { nonEmpty: true })
  if (hasOwn(candidate, 'chatReplies')) validateStringArray(candidate.chatReplies, 'chatReplies', errors, { nonEmpty: true })
  if (Array.isArray(candidate.chat)) candidate.chat.forEach((message, index) => {
    const path = `chat[${index}]`
    if (!isPlainObject(message)) { errors.push(profileError(path, 'must be an object')); return }
    if (!nonEmptyText(message.from)) errors.push(profileError(`${path}.from`, 'is required'))
    if (!nonEmptyText(message.text)) errors.push(profileError(`${path}.text`, 'is required'))
  })

  if (isPlainObject(candidate.chatContextReplies)) {
    for (const [key, replies] of Object.entries(candidate.chatContextReplies)) {
      validateStringArray(replies, `chatContextReplies.${key}`, errors, { nonEmpty: true })
    }
  }

  if (Array.isArray(candidate.channels)) {
    const ids = new Set()
    candidate.channels.forEach((channel, index) => {
      const path = `channels[${index}]`
      if (!isPlainObject(channel)) { errors.push(profileError(path, 'must be an object')); return }
      if (!safeIdentifier(channel.id)) errors.push(profileError(`${path}.id`, 'must be a safe identifier'))
      else if (ids.has(channel.id)) errors.push(profileError(`${path}.id`, `duplicates ${channel.id}`))
      else ids.add(channel.id)
      if (!nonEmptyText(channel.name)) errors.push(profileError(`${path}.name`, 'is required'))
      if (!nonEmptyText(channel.key)) errors.push(profileError(`${path}.key`, 'is required'))
    })
  }

  if (isPlainObject(candidate.board)) {
    for (const [channelId, messages] of Object.entries(candidate.board)) {
      if (!Array.isArray(messages)) { errors.push(profileError(`board.${channelId}`, 'must be an array')); continue }
      messages.forEach((message, index) => {
        const path = `board.${channelId}[${index}]`
        if (!isPlainObject(message)) { errors.push(profileError(path, 'must be an object')); return }
        if (!nonEmptyText(message.s)) errors.push(profileError(`${path}.s`, 'is required'))
        if (!nonEmptyText(message.t)) errors.push(profileError(`${path}.t`, 'is required'))
      })
    }
  }

  if (Array.isArray(candidate.conversations)) candidate.conversations.forEach((conversation, index) => {
    const path = `conversations[${index}]`
    if (!isPlainObject(conversation)) { errors.push(profileError(path, 'must be an object')); return }
    for (const key of ['id', 'a', 'b', 'key']) {
      if (!nonEmptyText(conversation[key])) errors.push(profileError(`${path}.${key}`, 'is required'))
    }
    if (nonEmptyText(conversation.id) && !safeIdentifier(conversation.id)) errors.push(profileError(`${path}.id`, 'must be a safe identifier'))
    if (conversation.child != null && !safeIdentifier(conversation.child)) errors.push(profileError(`${path}.child`, 'must be a safe identifier'))
    if (!isPlainObject(conversation.lines)) errors.push(profileError(`${path}.lines`, 'must be an object'))
    else {
      validateStringArray(conversation.lines.a, `${path}.lines.a`, errors, { nonEmpty: true })
      validateStringArray(conversation.lines.b, `${path}.lines.b`, errors, { nonEmpty: true })
    }
  })

  if (isPlainObject(candidate.ledger)) {
    for (const [kind, records] of [['requests', candidate.ledger.requests], ['questions', candidate.ledger.questions]]) {
      if (!Array.isArray(records)) continue
      records.forEach((record, index) => {
        const path = `ledger.${kind}[${index}]`
        if (!isPlainObject(record)) { errors.push(profileError(path, 'must be an object')); return }
        if (!safeIdentifier(record.id)) errors.push(profileError(`${path}.id`, 'must be a safe identifier'))
        if (record.parent !== undefined && !safeIdentifier(record.parent)) errors.push(profileError(`${path}.parent`, 'must be a safe identifier'))
        const subject = kind === 'requests' ? record.title : record.question
        if (!nonEmptyText(subject)) errors.push(profileError(`${path}.${kind === 'requests' ? 'title' : 'question'}`, 'is required'))
        const statuses = kind === 'requests'
          ? ['open', 'in-progress', 'gated', 'done', 'blocked']
          : ['pending', 'answered']
        if (!statuses.includes(record.status)) errors.push(profileError(`${path}.status`, `must be ${statuses.join(' or ')}`))
        if (kind === 'questions' && record.status === 'answered' && !nonEmptyText(record.answer)) {
          errors.push(profileError(`${path}.answer`, 'is required for an answered question'))
        }
      })
    }
  }

  for (const key of ['session', 'arrivals']) if (Array.isArray(candidate[key])) {
    candidate[key].forEach((turn, index) => {
      const path = `${key}[${index}]`
      if (!isPlainObject(turn)) { errors.push(profileError(path, 'must be an object')); return }
      if (!nonEmptyText(turn.who)) errors.push(profileError(`${path}.who`, 'is required'))
      if (!nonEmptyText(turn.text)) errors.push(profileError(`${path}.text`, 'is required'))
    })
  }
  for (const key of ['replies', 'replyActs']) if (hasOwn(candidate, key)) validateStringArray(candidate[key], key, errors)

  if (isPlainObject(candidate.speakers)) {
    for (const [speakerId, speaker] of Object.entries(candidate.speakers)) {
      if (!isPlainObject(speaker)) errors.push(profileError(`speakers.${speakerId}`, 'must be an object'))
      else if (typeof speaker.label !== 'string') errors.push(profileError(`speakers.${speakerId}.label`, 'must be text'))
      else {
        if (!safeCssClass(speaker.cls)) errors.push(profileError(`speakers.${speakerId}.cls`, 'must contain only CSS class tokens'))
        if (speaker.hue !== undefined && !safeHue(speaker.hue)) errors.push(profileError(`speakers.${speakerId}.hue`, 'must be a theme variable or hex colour'))
      }
    }
  }
}

export function validateFleetProfile(candidate, { allowSample = false } = {}) {
  const errors = []
  if (!isPlainObject(candidate)) {
    return Object.freeze({ ok: false, errors: Object.freeze([profileError('$', 'must be a JSON object')]) })
  }
  if (candidate.schemaVersion !== 1) errors.push(profileError('schemaVersion', 'must be 1'))
  if (!safeIdentifier(candidate.id)) errors.push(profileError('id', 'must be a safe identifier'))
  else if (!allowSample && candidate.id === SAMPLE_PROFILE.id) errors.push(profileError('id', 'sample is reserved for the bundled demonstration'))
  if (!nonEmptyText(candidate.label)) errors.push(profileError('label', 'is required'))

  if (!Array.isArray(candidate.machines) || candidate.machines.length === 0) {
    errors.push(profileError('machines', 'must contain at least one machine'))
  } else if (candidate.machines.length > 128) {
    errors.push(profileError('machines', 'cannot contain more than 128 machines'))
  } else {
    const ids = new Set()
    candidate.machines.forEach((machine, index) => validateMachine(machine, index, errors, ids))
  }

  if (!Array.isArray(candidate.transports) || candidate.transports.length === 0) {
    errors.push(profileError('transports', 'must declare at least one transport lane'))
  } else if (candidate.transports.length > 32) {
    errors.push(profileError('transports', 'cannot contain more than 32 transport lanes'))
  } else {
    const ids = new Set()
    candidate.transports.forEach((transport, index) => validateTransport(transport, index, errors, ids))
  }

  for (const key of PROFILE_ARRAY_SECTIONS) {
    if (key === 'machines' || key === 'transports' || !hasOwn(candidate, key)) continue
    if (!Array.isArray(candidate[key])) errors.push(profileError(key, 'must be an array'))
  }
  for (const key of ['pools', 'tasks', 'feed']) {
    if (hasOwn(candidate, key) && Array.isArray(candidate[key]) && candidate[key].length === 0) {
      errors.push(profileError(key, 'cannot be empty because the simulation reads it during startup'))
    }
  }
  for (const key of PROFILE_OBJECT_SECTIONS) {
    if (hasOwn(candidate, key) && !isPlainObject(candidate[key])) errors.push(profileError(key, 'must be an object'))
  }
  if (hasOwn(candidate, 'ledger')) {
    if (!isPlainObject(candidate.ledger)) errors.push(profileError('ledger', 'must be an object'))
    else {
      if (!Array.isArray(candidate.ledger.requests)) errors.push(profileError('ledger.requests', 'must be an array'))
      if (!Array.isArray(candidate.ledger.questions)) errors.push(profileError('ledger.questions', 'must be an array'))
    }
  }
  for (const key of PROFILE_TEXT_SECTIONS) {
    if (hasOwn(candidate, key) && typeof candidate[key] !== 'string') errors.push(profileError(key, 'must be text'))
  }

  if (candidate.dataSource !== undefined && candidate.dataSource !== null) {
    if (!isPlainObject(candidate.dataSource)) errors.push(profileError('dataSource', 'must be null or an object'))
    else {
      if (candidate.dataSource.kind !== 'directory') errors.push(profileError('dataSource.kind', 'must be directory'))
      if (!nonEmptyText(candidate.dataSource.path)) errors.push(profileError('dataSource.path', 'directory path is required'))
      else if (candidate.dataSource.path.length > 4096) errors.push(profileError('dataSource.path', 'is too long'))
      else if (candidate.dataSource.path.includes('\0')) errors.push(profileError('dataSource.path', 'cannot contain a NUL character'))
      else if (!/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(candidate.dataSource.path)) errors.push(profileError('dataSource.path', 'must be an absolute directory path'))
    }
  }

  validateContentSections(candidate, errors)

  return Object.freeze({ ok: errors.length === 0, errors: Object.freeze(errors) })
}

export function parseFleetProfile(text) {
  if (typeof text !== 'string') {
    return Object.freeze({ ok: false, errors: Object.freeze([profileError('$', 'profile input must be text')]) })
  }
  if (jsonBytes(text) > PROFILE_MAX_BYTES) {
    return Object.freeze({ ok: false, errors: Object.freeze([profileError('$', 'profile exceeds the 2 MiB limit')]) })
  }
  let profile
  try { profile = JSON.parse(text) } catch (error) {
    return Object.freeze({
      ok: false,
      errors: Object.freeze([profileError('$', `JSON is malformed: ${error?.message || error}`)]),
    })
  }
  const verdict = validateFleetProfile(profile)
  return verdict.ok
    ? Object.freeze({ ok: true, profile, errors: Object.freeze([]) })
    : Object.freeze({ ok: false, errors: verdict.errors })
}

export function serializeFleetProfile(profile) {
  const verdict = validateFleetProfile(profile)
  if (!verdict.ok) return Object.freeze({ ok: false, errors: verdict.errors })
  const text = `${JSON.stringify(profile, null, 2)}\n`
  if (jsonBytes(text) > PROFILE_MAX_BYTES) {
    return Object.freeze({ ok: false, errors: Object.freeze([profileError('$', 'profile exceeds the 2 MiB limit')]) })
  }
  return Object.freeze({ ok: true, text, errors: Object.freeze([]) })
}

function mergeProfile(stored) {
  if (!stored) return SAMPLE_PROFILE
  const machines = stored.machines.map(machine => nonEmptyText(machine.ip)
    ? machine
    : { ...machine, ip: machine.address })
  return Object.freeze({ ...SAMPLE_PROFILE, ...stored, machines })
}

function inheritedSampleSections(profile) {
  return PROFILE_INHERITABLE_SECTIONS.filter(key => !hasOwn(profile, key))
}

function readLocalCandidate() {
  try {
    const text = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (text == null) return { state: 'absent' }
    const parsed = parseFleetProfile(text)
    return parsed.ok
      ? { state: 'configured', profile: parsed.profile }
      : { state: 'invalid', errors: parsed.errors }
  } catch (error) {
    return { state: 'error', errors: [profileError('localStorage', `could not be read: ${error?.message || error}`, 'browser storage')] }
  }
}

function readDurableCandidate() {
  const bridge = globalThis.mcFleetProfile
  if (!bridge) return { state: 'unavailable' }
  const bootstrap = bridge.bootstrap
  if (!bootstrap || bootstrap.ok !== true) {
    const message = bootstrap?.error?.message || 'desktop profile bootstrap did not answer'
    return { state: 'error', errors: [profileError('userData', message, 'durable storage')] }
  }
  if (bootstrap.state === 'reset') return { state: 'reset' }
  if (!bootstrap.configured) return { state: 'absent' }
  const verdict = validateFleetProfile(bootstrap.profile)
  return verdict.ok
    ? { state: 'configured', profile: bootstrap.profile }
    : {
        state: 'invalid',
        errors: verdict.errors.map(error => profileError(error.path, error.message, 'durable storage')),
      }
}

function mirrorLocal(profile) {
  try { globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(profile)) } catch {}
}

function clearLocal() {
  try { globalThis.localStorage?.removeItem(STORAGE_KEY) } catch {}
}

function migrateLegacyProfile(profile) {
  const bridge = globalThis.mcFleetProfile
  if (!bridge?.migrateLegacy) return null
  try {
    const result = bridge.migrateLegacy(profile)
    return result?.ok
      ? null
      : profileError('userData', result?.error?.message || 'durable migration failed', 'durable storage')
  } catch (error) {
    return profileError('userData', `durable migration failed: ${error?.message || error}`, 'durable storage')
  }
}

function resolution(kind, source, rawProfile, errors = [], warnings = []) {
  const configured = Boolean(rawProfile)
  const inherited = configured ? inheritedSampleSections(rawProfile) : []
  return Object.freeze({
    kind,
    source,
    configured,
    rawProfile,
    profile: configured ? mergeProfile(rawProfile) : SAMPLE_PROFILE,
    errors: Object.freeze(errors),
    warnings: Object.freeze(warnings),
    inheritedSampleSections: Object.freeze(inherited),
  })
}

function resolveFleetProfile() {
  const durable = readDurableCandidate()
  const local = readLocalCandidate()

  /* Reset is a durable tombstone rather than a missing file. Without it, an
     old Chromium origin can resurrect the profile after a port change — the
     exact reinstall/port drift this userData copy exists to prevent. */
  if (durable.state === 'reset') {
    clearLocal()
    return resolution('unconfigured', 'durable reset', null)
  }

  if (durable.state === 'configured') {
    mirrorLocal(durable.profile)
    const warnings = local.state === 'invalid' || local.state === 'error'
      ? [profileError('localStorage', 'the browser copy was unreadable; the durable profile was loaded instead', 'browser storage')]
      : []
    return resolution('configured', 'durable userData', durable.profile, [], warnings)
  }

  if (local.state === 'configured') {
    const errors = durable.state === 'invalid' || durable.state === 'error' ? [...durable.errors] : []
    if (durable.state === 'absent') {
      const migrationError = migrateLegacyProfile(local.profile)
      if (migrationError) errors.push(migrationError)
    }
    return resolution(errors.length ? 'recovered' : 'configured', 'legacy browser storage', local.profile, errors)
  }

  const errors = [
    ...(durable.state === 'invalid' || durable.state === 'error' ? durable.errors : []),
    ...(local.state === 'invalid' || local.state === 'error' ? local.errors : []),
  ]
  return errors.length
    ? resolution('invalid', 'sample fallback', null, errors)
    : resolution('unconfigured', 'bundled sample', null)
}

export async function persistFleetProfile(profile) {
  const verdict = validateFleetProfile(profile)
  if (!verdict.ok) return Object.freeze({ ok: false, errors: verdict.errors })
  const serialized = serializeFleetProfile(profile)
  if (!serialized.ok) return serialized

  const bridge = globalThis.mcFleetProfile
  if (bridge?.save) {
    let durable
    try { durable = await bridge.save(profile) } catch (error) {
      durable = { ok: false, error: { message: error?.message || String(error) } }
    }
    if (!durable?.ok) {
      return Object.freeze({
        ok: false,
        errors: Object.freeze([profileError('userData', durable?.error?.message || 'durable save failed', 'durable storage')]),
      })
    }
  }

  try { globalThis.localStorage?.setItem(STORAGE_KEY, serialized.text.trimEnd()) } catch (error) {
    if (!bridge?.save) {
      return Object.freeze({
        ok: false,
        errors: Object.freeze([profileError('localStorage', `save failed: ${error?.message || error}`, 'browser storage')]),
      })
    }
    return Object.freeze({
      ok: true,
      warnings: Object.freeze([profileError('localStorage', 'durable save succeeded, but the browser mirror could not be updated', 'browser storage')]),
    })
  }
  return Object.freeze({ ok: true, warnings: Object.freeze([]) })
}

export async function resetFleetProfile() {
  const bridge = globalThis.mcFleetProfile
  if (bridge?.reset) {
    let durable
    try { durable = await bridge.reset() } catch (error) {
      durable = { ok: false, error: { message: error?.message || String(error) } }
    }
    if (!durable?.ok) {
      return Object.freeze({
        ok: false,
        errors: Object.freeze([profileError('userData', durable?.error?.message || 'durable reset failed', 'durable storage')]),
      })
    }
  }
  try { globalThis.localStorage?.removeItem(STORAGE_KEY) } catch (error) {
    if (!bridge?.reset) {
      return Object.freeze({
        ok: false,
        errors: Object.freeze([profileError('localStorage', `reset failed: ${error?.message || error}`, 'browser storage')]),
      })
    }
  }
  return Object.freeze({ ok: true })
}

/* ASKED, NOT IMPORTED, and that is a cycle rather than a preference:
   src/data-source.js reaches src/mission-bridge.js, which reaches this module
   for the profile it reads its endpoint from. The stored choice is one
   localStorage key with one spelling, and reading it here directly is what
   keeps the two files from importing each other. The key and the rule are
   src/data-source.js's -- isExampleMode() is the authority and this is a
   read-only echo of it. */
function exampleIsOn() {
  try { return globalThis.localStorage?.getItem('mc.example') === 'on' } catch { return false }
}

function mountRuntimeProfileNotice(message, serious = false) {
  if (typeof document === 'undefined' || !message) return
  const mount = () => {
    let notice = document.querySelector('[data-fleet-profile-notice]')
    if (!notice) {
      notice = document.createElement('a')
      notice.href = '#/settings'
      notice.dataset.fleetProfileNotice = 'true'
      notice.className = 'fleet-profile-notice'
      document.body.appendChild(notice)
    }
    notice.classList.toggle('is-serious', serious)
    notice.setAttribute('role', serious ? 'alert' : 'status')
    notice.textContent = `${message} Open Settings →`
  }
  if (document.body) mount()
  else document.addEventListener('DOMContentLoaded', mount, { once: true })
}

export const FLEET_PROFILE_RESOLUTION = resolveFleetProfile()
export const FLEET = FLEET_PROFILE_RESOLUTION.profile

const EXAMPLE_NOTICE = 'Every screen is showing the built-in example rather than your own records.'

// Phone demo entry changes the preference within the existing document.
// Preserve configured-profile and fault notices; only the unconfigured demo
// disclosure follows this preference. Desktop behavior is unchanged.
export function syncPhoneExampleNotice() {
  if (typeof document === 'undefined'
      || document.documentElement?.getAttribute('data-phone-canvas') !== 'on'
      || FLEET_PROFILE_RESOLUTION.kind !== 'unconfigured') return
  const notice = document.querySelector('[data-fleet-profile-notice]')
  if (notice?.classList.contains('is-serious')) return
  if (exampleIsOn()) mountRuntimeProfileNotice(EXAMPLE_NOTICE)
  else notice?.remove()
}

if (FLEET_PROFILE_RESOLUTION.kind === 'invalid') {
  const first = FLEET_PROFILE_RESOLUTION.errors[0]
  mountRuntimeProfileNotice(`Fleet profile was not loaded: ${first?.path || 'profile'} ${first?.message || 'is invalid'}. The sample demonstration is active.`, true)
} else if (!FLEET_PROFILE_RESOLUTION.configured) {
  /* ONE STATEMENT, because this banner floats over every screen and cannot see
     what the screen under it is already saying.
     It used to be two: "this is a labelled sample fleet, not your machines" AND
     "ToolsEnabled already works on this one computer". On home the second
     sentence landed two inches below the page's own "No local agent fleet host
     detected on this machine", and a person cannot act on both. The banner now
     says only the thing that is true on every route it appears over, in the
     tense of a next step rather than a correction. Home suppresses it outright
     (see src/home.css) because home states its own source itself. */
  /* IT ONLY SAYS THIS WHEN IT IS TRUE, and on a fresh install it usually is
     not. The banner floated over every screen announcing "Some screens show
     example data until you connect your own computers" while the same install
     said, three inches away, that "Show the example fleet" was Off, that the
     screens were showing the person's own activity, and (on #/computers) that
     there was honestly nothing to show yet. Two scouts found the contradiction
     independently.

     Whether other computers are configured and whether a worked example is on
     screen are two questions, and only the second one decides this sentence.
     src/data-source.js owns the answer -- example on means mock, badged,
     everywhere -- so it is asked rather than inferred. With the example off
     there is nothing here worth floating over the product: the screens are
     already saying what they are showing. */
  if (exampleIsOn()) {
    mountRuntimeProfileNotice(EXAMPLE_NOTICE)
  }
} else if (FLEET_PROFILE_RESOLUTION.kind === 'recovered') {
  mountRuntimeProfileNotice('The fleet loaded from browser storage, but its durable userData copy needs attention.', true)
} else if (FLEET_PROFILE_RESOLUTION.warnings.length) {
  mountRuntimeProfileNotice(`The fleet loaded from durable storage, but ${FLEET_PROFILE_RESOLUTION.warnings[0].message}.`, true)
} else if (FLEET_PROFILE_RESOLUTION.rawProfile?.dataSource && !globalThis.mcFleetProfile) {
  mountRuntimeProfileNotice('This profile names a local projection directory, but a browser cannot read it. Use the installed desktop app; bundled data is not that configured source.', true)
} else if (FLEET_PROFILE_RESOLUTION.inheritedSampleSections.length) {
  mountRuntimeProfileNotice(`Fleet connections are configured; ${FLEET_PROFILE_RESOLUTION.inheritedSampleSections.length} content sections still use the labelled sample demonstration.`)
}

export const isSampleFleet = () => !FLEET_PROFILE_RESOLUTION.configured
