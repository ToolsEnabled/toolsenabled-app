/* The home screen cannot contradict itself, repeat itself, or talk like a
 * README. Those are the three defects the owner reported, and this file is what
 * stops each of them coming back.
 *
 * WHY THE INVARIANTS ARE WALKED EXHAUSTIVELY RATHER THAN SAMPLED.
 *
 * The measured defect was not a wrong branch. Every branch of the old screen
 * was individually correct: the ring correctly reported that it had no health
 * reading, the panel correctly reported that it could not reach a coordinator,
 * and the banner correctly reported that the app works locally. The product was
 * broken by the COMBINATION, which no per-branch test can see. So the test
 * builds every reachable input to describeHome() -- thousands of them -- and
 * asserts a property of the whole rendered sentence set each time.
 *
 * That is only possible because describeHome() returns sentences as values.
 * A version of this screen that assembled its copy inside a render function
 * could not be checked this way at all, which is the reason it is not one.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  COPY,
  ENGINE_REASON,
  HOME_MODES,
  RUN_BRIEF_CHARS,
  RUN_SAID_CHARS,
  describeHome,
  describeRun,
  readAgentEngine,
  readLocalSessions,
  summariseRunWork,
  whenWords,
} from '../../src/local-activity.js'
import { providerSignInReading } from '../../src/agent-availability-copy.js'
/* THE DOOR IS ASSERTED BY THE CONSTANT, NEVER BY ITS SPELLING. Home's job is to
   lead somewhere that can explain; where that somewhere lives is the product's
   decision, and it has already moved once (a page called "What this copy needs"
   became a section of Settings). A literal here would have failed that move and
   the quickest way back to green would have been to reinstate the old page. */
import { GUIDE_HREF } from '../../src/first-run-needs.js'

const NOW = Date.parse('2026-08-11T12:00:00.000Z')
const minutes = (n) => n * 60_000

/* ------------------------------------------------------------------
   Every reachable input.
   ------------------------------------------------------------------ */

const historyReply = (count, verified = true) => ({
  ok: true,
  total: count,
  verified,
  entries: Array.from({ length: count }, (_value, index) => ({
    sequence: count - index,
    at: new Date(NOW - minutes(index + 1)).toISOString(),
    action: 'agent_session_start',
  })),
})

/* The same reply, with the outcome records a run now leaves behind. `results`
   is one entry per run, newest first, each 'started' | 'refused' | null, where
   null is a run recorded before outcomes existed. */
const historyReplyWithOutcomes = (results, verified = true) => {
  const count = results.length
  const starts = Array.from({ length: count }, (_value, index) => ({
    sequence: count - index,
    at: new Date(NOW - minutes(index + 1)).toISOString(),
    action: 'agent_session_start',
    outcome: null,
  }))
  const outcomes = results
    .map((result, index) => (result === null ? null : {
      sequence: count + count - index,
      at: new Date(NOW - minutes(index + 1)).toISOString(),
      action: 'agent_session_outcome',
      outcome: { result, resolves: count - index, reason: result === 'refused' ? 'CODEX_CLI_NOT_FOUND' : null },
    }))
    .filter(Boolean)
  return {
    ok: true,
    total: count + outcomes.length,
    verified,
    entries: [...outcomes, ...starts],
    outcomes: {
      starts: count,
      started: results.filter(result => result === 'started').length,
      refused: results.filter(result => result === 'refused').length,
    },
  }
}

test('three runs that all failed are not reported as three runs that are fine', () => {
  /* THE MEASURED DEFECT, kept as a test. After three starts that every one of
     them refused, this screen read "3 agent runs on this computer" over
     "All 3 runs still check out" -- and a person reading it had no way to learn
     that nothing had worked. The record really was intact; that was never the
     question being asked. */
  const sessions = readLocalSessions(historyReplyWithOutcomes(['refused', 'refused', 'refused']))
  const view = describeHome({
    fleetConfigured: false,
    sessions,
    engine: readAgentEngine({ ok: true }),
    nowMs: NOW,
  })

  /* THE FAILURE IS STATED ON EACH ROW, NOT IN A PARAGRAPH UNDER THE LIST. The
     footer that used to carry "none of them started" is gone on every healthy
     record (owner: "this little dialog box is kind of pointless"), so the
     row's own verdict is the whole of the statement and the footer is null --
     never the reassuring integrity sentence. */
  assert.equal(view.panel.footer, null, 'a healthy record grew a footer paragraph again')
  for (const run of sessions.runs) {
    const row = describeRun(run, null, NOW)
    assert.equal(row.resultWord, 'did not start', 'the failure has to be stated, not implied')
  }

  /* And the count is of RUNS. An outcome is a second ledger line, so a reply
     carrying 3 runs and 3 outcomes is 6 records -- reporting 6 would trade one
     wrong number for another. */
  assert.match(view.headline, /^3 agent runs/, `counted the ledger lines instead of the runs: ${view.headline}`)
  assert.equal(view.panel.runs, true)
})

test('a run says what it did, and says nothing when nobody wrote it down', () => {
  assert.equal(COPY.runResult('refused'), 'did not start')
  assert.equal(COPY.runResult('started'), 'started')
  /* The branch the generic copy walk cannot reach, and the one that matters:
     an unrecorded outcome must produce NO word rather than a reassuring one. */
  assert.equal(COPY.runResult(null), '')
  assert.equal(COPY.runResult(undefined), '')
  assert.equal(COPY.runResult('anything else'), '')

  const mixedSessions = readLocalSessions(historyReplyWithOutcomes(['started', 'refused', null]))
  const mixed = describeHome({
    fleetConfigured: false,
    sessions: mixedSessions,
    engine: readAgentEngine({ ok: true }),
    nowMs: NOW,
  })
  /* Per row now, and no aggregate paragraph: started, did not start, and the
     unrecorded one says nothing. */
  assert.equal(mixed.panel.footer, null)
  assert.deepEqual(
    mixedSessions.runs.map(run => describeRun(run, null, NOW).resultWord),
    ['started', 'did not start', ''],
  )
  /* The aggregate sentence still exists for the metrics page, and still says
     nothing invented. */
  assert.match(COPY.runOutcomes(1, 1, 3), /1 of 3 did not start/i)
  assert.equal(COPY.runOutcomes(0, 0, 3), null)

  /* A ledger with no outcomes at all -- every record written before this
     existed -- gains no summary rather than an invented one. */
  const legacy = describeHome({
    fleetConfigured: false,
    sessions: readLocalSessions(historyReply(3, true)),
    engine: readAgentEngine({ ok: true }),
    nowMs: NOW,
  })
  assert.equal(legacy.panel.footer, null)
})

const SESSION_INPUTS = [
  ['no shell to ask', undefined],
  ['asked, unreadable', { ok: false, code: 'SPAWN_RECORD_LEDGER_UNREADABLE' }],
  ['asked, malformed', { ok: true }],
  ['no runs yet', { ok: true, total: 0, verified: true, entries: [] }],
  ['one run', historyReply(1)],
  ['many runs', historyReply(7)],
  ['runs, chain broken', historyReply(4, false)],
  ['runs, verification unknown', historyReply(4, null)],
]

const ENGINE_INPUTS = [
  ['no shell to ask', undefined],
  ['ready', { ok: true, code: 'SPAWN_RECORD_READY' }],
  ['no engine', { ok: false, code: 'AGENT_ENGINE_UNAVAILABLE' }],
  ['no keystore', { ok: false, code: 'SPAWN_RECORD_KEYSTORE_UNAVAILABLE' }],
  ['unknown code', { ok: false, code: 'SOMETHING_NEW' }],
]

const HEALTH_INPUTS = [
  ['none', null],
  ['all clear', { available: true, atMs: NOW - minutes(3), total: 14, ok: 14, down: 0, unknown: 0 }],
  ['some down', { available: true, atMs: NOW - minutes(3), total: 14, ok: 11, down: 3, unknown: 0 }],
  ['some unknown', { available: true, atMs: NOW - minutes(3), total: 14, ok: 12, down: 0, unknown: 2 }],
  ['a single service', { available: true, atMs: NOW - minutes(3), total: 1, ok: 1, down: 0, unknown: 0 }],
]

const PEER_INPUTS = [
  ['none', null],
  ['reachable', { reachable: true, name: 'the studio machine', atMs: NOW - minutes(9) }],
]

/* The last five carry `undelivered`: decisions the owner already made whose
   answer came back refused after he had navigated off #/approvals (see
   src/approval-outcomes.js). They are in the reachable matrix, not in a test of
   their own, because that row has to satisfy the SAME rules as every other row
   on this screen -- no contradiction, no near-duplicate, no fourth line under
   the ring, and the plain register -- and a state that only a bespoke test ever
   visits is a state those rules never actually policed. The absence cases are
   here on purpose: a missing field, and a count that outruns the queue it is
   supposed to be a subset of. */
const APPROVAL_INPUTS = [
  ['not asked', null],
  ['unreadable', { readable: false, count: 0 }],
  ['none waiting', { readable: true, count: 0 }],
  ['one waiting', { readable: true, count: 1 }],
  ['several waiting', { readable: true, count: 5 }],
  ['one waiting, its decision not recorded', { readable: true, count: 1, undelivered: 1 }],
  ['several waiting, one decision not recorded', { readable: true, count: 5, undelivered: 1 }],
  ['several waiting, three decisions not recorded', { readable: true, count: 5, undelivered: 3 }],
  ['a failure count that outruns the queue', { readable: true, count: 1, undelivered: 4 }],
  ['nothing waiting but a failure count left over', { readable: true, count: 0, undelivered: 2 }],
  ['unreadable, with a failure count left over', { readable: false, count: 0, undelivered: 2 }],
]

function everyReachableInput() {
  const out = []
  for (const sample of [false, true]) {
    for (const fleetConfigured of [false, true]) {
      for (const [healthLabel, fleetHealth] of HEALTH_INPUTS) {
        for (const [peerLabel, peer] of PEER_INPUTS) {
          for (const [sessionLabel, sessionRaw] of SESSION_INPUTS) {
            for (const [engineLabel, engineRaw] of ENGINE_INPUTS) {
              for (const [approvalLabel, approvals] of APPROVAL_INPUTS) {
                out.push({
                  label: `sample=${sample} fleet=${fleetConfigured} health=${healthLabel} `
                    + `peer=${peerLabel} sessions=${sessionLabel} engine=${engineLabel} approvals=${approvalLabel}`,
                  input: {
                    sample,
                    fleetConfigured,
                    fleetHealth,
                    peer,
                    sessions: readLocalSessions(sessionRaw),
                    engine: readAgentEngine(engineRaw),
                    approvals,
                    nowMs: NOW,
                  },
                })
              }
            }
          }
        }
      }
    }
  }
  return out
}

const ALL = everyReachableInput()

/* ------------------------------------------------------------------
   1. It never contradicts itself.
   ------------------------------------------------------------------ */

/* A contradiction is two statements taking OPPOSITE POLARITY on the SAME
   SUBJECT in one render. The two subjects below are not arbitrary: they are
   exactly the pair the owner was shown -- can this product do anything on this
   computer, and are there other computers -- and the measured failure was one
   positive and one negative claim about the first, printed together. */
const SUBJECTS = [
  {
    id: 'this computer can run agents',
    positive: [/agents can run on this computer/i, /already works on this/i],
    negative: [
      /no local agent fleet host/i,
      /cannot run agents/i,
      /not set up to run agents/i,
      /will not start an agent/i,
      /will not add to it/i,
      /shutting down/i,
    ],
  },
  {
    id: 'other computers',
    positive: [/^connected to /i],
    negative: [
      /could not be reached/i,
      /nothing has been heard from them/i,
      /running in a browser/i,
    ],
  },
  /* THE THIRD SUBJECT, AND IT IS THE ONE THE OWNER REPORTED. "This is the only
     computer connected" used to be the first screen's only sentence carrying
     that word, and it meant the LAN fleet, on a screen a person reaches minutes
     after being asked on the website to connect a computer. The row is an
     ACCOUNT row now, so the same no-contradiction rule has to hold over it. */
  {
    id: 'this computer is on the account',
    positive: [/is on your ToolsEnabled account/i],
    negative: [/is not on your ToolsEnabled account yet/i],
  },
]

const hits = (patterns, statements) => statements.filter(s => patterns.some(p => p.test(s)))

test('no reachable home screen states both sides of the same fact', () => {
  for (const { label, input } of ALL) {
    const { statements } = describeHome(input)
    for (const subject of SUBJECTS) {
      const yes = hits(subject.positive, statements)
      const no = hits(subject.negative, statements)
      assert.ok(
        yes.length === 0 || no.length === 0,
        `contradiction about "${subject.id}" with ${label}\n  says: ${JSON.stringify(yes)}\n  and:  ${JSON.stringify(no)}`,
      )
    }
  }
})

/* NEAR-duplicates count, and this is not a refinement -- it is the defect
 * itself. What the owner was shown was "No local agent fleet host detected on
 * this machine" printed TWICE, and the first version of this rewrite put "No
 * agent has run here yet" in the hero next to "No agents have run here yet" in
 * the panel, which an exact-match check waves straight through and a person
 * reads as the screen stuttering.
 *
 * So statements are compared after normalising away the differences that carry
 * no meaning: case, punctuation, plural s, and the auxiliary verbs and articles
 * that shift when a sentence is rephrased rather than restated. Two statements
 * that survive that as the same string are the same statement. */
const FILLER = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'has', 'have', 'had', 'be', 'been',
  'to', 'of', 'on', 'in', 'it', 'this', 'that', 'your', 'you', 'and', 'so', 'here',
])

function normalize(statement) {
  return statement
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(word => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word))
    .filter(word => !FILLER.has(word))
    .join(' ')
}

function jaccard(left, right) {
  const a = new Set(left.split(' ').filter(Boolean))
  const b = new Set(right.split(' ').filter(Boolean))
  if (a.size === 0 || b.size === 0) return 0
  const shared = [...a].filter(word => b.has(word)).length
  return shared / (a.size + b.size - shared)
}

test('no reachable home screen says the same thing twice, in any words', () => {
  for (const { label, input } of ALL) {
    const { statements } = describeHome(input)
    const normalized = statements.map(normalize)
    for (let i = 0; i < statements.length; i += 1) {
      for (let j = i + 1; j < statements.length; j += 1) {
        assert.notEqual(
          normalized[i], normalized[j],
          `the same statement twice with ${label}:\n  ${JSON.stringify(statements[i])}\n  ${JSON.stringify(statements[j])}`,
        )
        const overlap = jaccard(normalized[i], normalized[j])
        assert.ok(
          overlap < 0.8,
          `two statements are ${Math.round(overlap * 100)}% the same with ${label}:`
          + `\n  ${JSON.stringify(statements[i])}\n  ${JSON.stringify(statements[j])}`,
        )
      }
    }
  }
})

test('no reachable home screen states more than three facts under the ring', () => {
  /* Five unavailability notices in one viewport is the thing that made this
     screen unreadable, so there is a cap. THREE, not five and not a comfortable
     four: the cap is set to the actual maximum the current copy produces, so
     adding a fourth row is a decision someone has to make on purpose by editing
     this line. A cap with slack in it is not a cap -- a first mutation round
     planted a fourth row and this assertion, then written as `<= 4`, waved it
     straight through. */
  for (const { label, input } of ALL) {
    const { facts } = describeHome(input)
    assert.ok(facts.length <= 3, `${facts.length} facts with ${label}`)
    assert.equal(new Set(facts.map(fact => fact.id)).size, facts.length, `duplicate fact ids with ${label}`)
  }
})

/* ------------------------------------------------------------------
   2. It is written for a person.
   ------------------------------------------------------------------ */

/* Verbatim from the screen the owner was shown, plus the rest of the register
   it came from. Each of these names a mechanism rather than a thing a person
   has. */
const INTERNAL_VOCABULARY = [
  /projection/i,
  /audited bridge/i,
  /coordinator thread/i,
  /health sweep/i,
  /source unavailable/i,
  /read-only/i,
  /envelope/i,
  /payload/i,
  /schema/i,
  /\bIPC\b/,
  /localhost|127\.0\.0\.1/,
  /subsystem/i,
  /durable/i,
  /idempotenc/i,
  /snapshot/i,
  /\bfleet host\b/i,
]

/* The punctuation of a technical document. The owner named this directly:
   "What is with all the symbols in the writing thats a readme". */
const README_PUNCTUATION = [
  ['·', 'interpunct used as a separator'],
  ['…', 'ellipsis'],
  ['—', 'em dash'],
  ['●', 'filled-circle bullet'],
  ['→', 'arrow'],
  ['|', 'pipe'],
]

test('no reachable home screen names a mechanism instead of a thing a person has', () => {
  for (const { label, input } of ALL) {
    for (const statement of describeHome(input).statements) {
      for (const pattern of INTERNAL_VOCABULARY) {
        assert.doesNotMatch(statement, pattern, `internal vocabulary with ${label}: ${JSON.stringify(statement)}`)
      }
    }
  }
})

test('no reachable home screen punctuates like a README', () => {
  for (const { label, input } of ALL) {
    for (const statement of describeHome(input).statements) {
      for (const [character, name] of README_PUNCTUATION) {
        assert.ok(
          !statement.includes(character),
          `${name} with ${label}: ${JSON.stringify(statement)}`,
        )
      }
      /* Shouted words. Two-letter initialisms are fine; a word is not. */
      const shouted = statement.match(/\b[A-Z]{3,}\b/g)
      assert.equal(shouted, null, `uppercase word with ${label}: ${JSON.stringify(shouted)}`)
    }
  }
})

/* The sentences that do not come from describeHome, because they depend on the
   moment rather than on the machine's state -- loading, the composer's label,
   what the reply control says while a message goes out. They are still
   sentences a person reads, so they take the same rules. Functions are called
   with a sample argument so the interpolated whole is checked, not just its
   fixed half. */
/* ONE SAMPLE ARGUMENT PER FUNCTION, DECLARED, and the walk refuses to run
 * without one.
 *
 * The walk used to pass the string 'coordinator' to every function it found,
 * which was right while every one of them interpolated a name. It stopped being
 * right the moment a copy function took a READING -- COPY.runDid() is handed
 * what the per-turn record says a run cost, and handed a name it correctly
 * answers with nothing at all, so the walk reported the sentence as empty and
 * said nothing whatever about the sentence a person really sees.
 *
 * Declaring the samples fixes both halves of that. Every function is checked on
 * an argument of the shape it is actually called with, so the rules below apply
 * to real sentences; and a new copy function with no sample listed fails this
 * suite rather than being waved through on a name it never wanted. */
const COPY_SAMPLES = new Map([
  ['COPY.runLabel', [7]],
  ['COPY.runResult', ['started']],
  ['COPY.runReason', ['AGENT_TIER_NO_LAUNCHER']],
  ['COPY.runAsked', ['Read the build log and tell me what broke.']],
  ['COPY.runSaid', ['The build failed on the second step.']],
  ['COPY.runDid', [{ turns: 4, model: 'Sonnet', tokens: 18412, unfinished: 1 }]],
  ['COPY.runOutcomes', [2, 1, 3]],
  ['COPY.chatboxAgentsHeld', [2]],
  ['COPY.composerLive', ['coordinator']],
  ['COPY.turnAgent', ['helper']],
  ['COPY.threadLabel', ['codex']],
  ['COPY.treeScopeTitle', ['Controller tree']],
])

function everyCopyString(value, path = 'COPY') {
  if (typeof value === 'string') return [[path, value]]
  if (typeof value === 'function') {
    assert.ok(COPY_SAMPLES.has(path),
      `${path} is a copy function with no sample argument declared in COPY_SAMPLES, so nothing checks the sentence it really produces`)
    return [[`${path}()`, value(...COPY_SAMPLES.get(path))]]
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) => everyCopyString(child, `${path}.${key}`))
  }
  return []
}

/* The one entry whose empty answer is the point rather than a gap.
 *
 * COPY.runResult() labels a run "started" or "did not start" and returns the
 * EMPTY STRING for a run whose outcome was never recorded -- which is every run
 * from before outcomes were kept. That silence is deliberate and load-bearing:
 * the defect this whole area was repaired for is a screen that turned an
 * unrecorded outcome into a reassuring one, and a word invented here to satisfy
 * a non-empty rule would put that defect straight back. The generic walk below
 * calls every function with one sample argument, which for this function
 * necessarily lands on exactly that branch, so it is named here and checked
 * properly by the test underneath instead. */
/* COPY.runReason() joins it for the same reason, one step further on. It turns
   the bare code the record kept into ENGINE_REASON's sentence, and answers the
   EMPTY STRING for a code nobody wrote one for -- and for the sample argument
   the walk below happens to pass, which is not a code at all. A non-empty
   fallback here would be this screen explaining a refusal it was never told the
   reason for, which is the same invention in the opposite direction. The
   behaviour is checked properly by the test underneath. */
/* Both are now walked on an argument they were designed for -- a recorded
   outcome and a code the tree really refuses with -- so neither is silent here
   any more. The silence each one keeps for an input nobody wrote a sentence for
   is the point of both, and it is checked by name in the tests below rather
   than by a hole in this walk. */
const DELIBERATELY_SILENT = new Set()

/* WHY A REFUSED RUN NOW SAYS WHY, AND WHY IT SOMETIMES STILL DOES NOT.
 *
 * The owner's report: "Activity on this computer" showed "Agent run 37 -
 * started" or "did not start" and a relative time, and nothing else. The record
 * held more than that the whole time -- the shell writes a bare refusal code
 * beside every refused outcome and readLocalSessions dropped it on the floor.
 * So a person whose every start was refused read "did not start" nine times
 * over a file that knew the answer.
 *
 * The silence that remains is deliberate and is the same rule as runResult's:
 * a code with no sentence, or a run recorded before reasons were kept, gets no
 * line. The row then says exactly what it always said. */
test('a refused run says why when the record knows, and nothing when it does not', () => {
  const known = COPY.runReason('AGENT_TIER_NO_LAUNCHER')
  assert.ok(known.length > 0, 'the code the tree really refuses with has no sentence on this screen')
  assert.equal(known, ENGINE_REASON.AGENT_TIER_NO_LAUNCHER,
    'the runs list words a refusal differently from the engine line above it; one machine, two explanations')
  for (const nothing of [null, undefined, '', 'NOT_A_CODE_ANYONE_WROTE', 42, {}]) {
    assert.equal(COPY.runReason(nothing), '',
      `a run whose reason is ${JSON.stringify(nothing)} was given an explanation nobody recorded`)
  }
})

/* THE JOIN, AND THE ABSENCE IT MUST SURVIVE. describeRun answers with what the
 * signed record holds plus what this computer saved about that session. A run
 * with no saved conversation -- another surface, another machine's record, a
 * build from before session ids crossed -- must lose the two extra lines and
 * keep everything else, or this feature costs people the history they had. */
test('a run names its agent and its brief when they were saved, and degrades to what it always showed', () => {
  const now = Date.UTC(2026, 7, 17, 12, 0, 0)
  const conversations = new Map([['chat-a', { role: 'Coordinator', asked: '  Read the build\n  log   and say what broke. ' }]])
  const matched = describeRun(
    { sequence: 12, atMs: now - 3_600_000, result: 'refused', reason: 'AGENT_TIER_NO_LAUNCHER', sessionId: 'chat-a' },
    conversations, now,
  )
  assert.equal(matched.agent, 'Coordinator')
  assert.equal(matched.asked, 'Read the build log and say what broke.', 'the brief was not collapsed to one line')
  assert.ok(matched.why.length > 0, 'a refusal with a known code said nothing')
  assert.equal(matched.resultWord, 'did not start')
  assert.equal(matched.when, 'an hour ago')

  const unmatched = describeRun(
    { sequence: 13, atMs: now - 60_000, result: 'started', reason: null, sessionId: 'chat-nobody-saved' },
    conversations, now,
  )
  assert.equal(unmatched.agent, '', 'a run with no saved conversation invented an agent')
  assert.equal(unmatched.asked, '', 'a run with no saved conversation invented a brief')
  assert.equal(unmatched.why, '', 'a run that started was given a refusal reason')
  assert.equal(unmatched.resultWord, 'started')

  /* No conversations at all is the ordinary state of a computer whose agents
     were started from another surface. It must not throw and must not blank
     the row. */
  const alone = describeRun({ sequence: 1, atMs: now, result: null, reason: null, sessionId: null }, null, now)
  assert.equal(alone.agent, '')
  assert.equal(alone.asked, '')
  assert.equal(alone.resultWord, '', 'a run with no recorded outcome was labelled')
  assert.equal(alone.when, 'just now')

  /* A brief longer than the column is clipped, not wrapped into the page. */
  const long = describeRun(
    { sequence: 2, atMs: now, result: 'started', reason: null, sessionId: 'chat-a' },
    new Map([['chat-a', { role: 'Worker', asked: 'x'.repeat(400) }]]), now,
  )
  assert.ok(long.asked.length <= RUN_BRIEF_CHARS, `a ${long.asked.length}-character brief reached the row`)
  assert.ok(long.asked.endsWith('…'), 'a clipped brief does not say it was clipped')
})

/* ==================================================================
   THE CONTEXT FLOW. The owner, on the installed build: "on page 1 this is
   supposed to be a context flow of all the agents and such we want to see their
   outputs cleanly." What he was shown was a row per run carrying a number, a
   verb and a relative time.

   It could not have shown an output however long he waited. The join read
   `role` and `message` off the saved node and stopped, and `reply` -- the field
   that exists on that node so a screen can show what the agent answered -- was
   never read by either of the two readers of that record. These tests are what
   stop the row losing any of its four answers again.
   ================================================================== */

const RUN = (over = {}) => ({ sequence: 3, atMs: NOW - minutes(9), result: 'started', reason: null, sessionId: 'chat-a', ...over })
/* One saved node, in the shape src/session-roles.js really hands over. */
const SAVED = (over = {}) => new Map([['chat-a', {
  role: 'helper',
  asked: 'Assist the coordinator and check in first.',
  reply: '',
  said: '',
  status: 'finished',
  statusNote: '',
  tier: 'claude-sonnet',
  nodeId: 'node-a',
  computerId: 'pc-1',
  ...over,
}]])

test('a run shows what the agent said back, from the field the answer was kept on', () => {
  const said = describeRun(RUN(), SAVED({ reply: 'Checked in with the coordinator and started on the log.' }), NOW)
  assert.equal(said.said, 'Checked in with the coordinator and started on the log.',
    'the answer the node kept is not on the row; this is the owner’s report, unfixed')
  assert.equal(said.asked, 'Assist the coordinator and check in first.')
  assert.equal(said.agent, 'helper')
  assert.equal(said.gap, '', 'a run that answered was told it had not')
  assert.ok(COPY.runSaid(said.said).startsWith('Said back'), 'the answer reaches the glass unlabelled')
})

test('the saved conversation answers when the node kept no reply of its own', () => {
  const said = describeRun(RUN(), SAVED({ reply: '', said: 'The build failed on the second step.' }), NOW)
  assert.equal(said.said, 'The build failed on the second step.',
    'a node whose reply was cleared loses an answer the saved conversation still holds')
})

test('a live turn outranks both, so the row shows the words as they arrive', () => {
  const said = describeRun(RUN(), SAVED({ reply: 'An older answer.' }), NOW, { live: { working: true, text: 'Reading the log' } })
  assert.equal(said.said, 'Reading the log', 'the row shows a stale answer while a newer one is being typed')
  assert.equal(said.working, true, 'a run this window is watching does not say so')
  assert.equal(said.gap, '', 'a run that is talking right now was reported as silent')
})

test('a long answer is clipped rather than pouring the whole conversation onto the screen', () => {
  const said = describeRun(RUN(), SAVED({ reply: 'x'.repeat(4000) }), NOW)
  assert.ok(said.said.length <= RUN_SAID_CHARS, `a ${said.said.length}-character answer reached the row`)
  assert.ok(said.said.endsWith('…'), 'a clipped answer does not say it was clipped')
})

/* THE RUN THAT STRUCTURALLY CANNOT JOIN TO ANYTHING. A run started from the
   agent page mints a session, is written to the signed record, and creates NO
   node -- so there is no role, no brief and no reply anywhere to find. The row
   must say that in words. A blank reads as a screen that is broken, and an
   invented ask would be this screen making one up. */
test('a run with nothing saved about it says so, and never invents an ask', () => {
  const said = describeRun(RUN({ sessionId: 'chat-nowhere' }), SAVED(), NOW)
  assert.equal(said.asked, '', 'a brief appeared for a run that never had one')
  assert.equal(said.said, '', 'an answer appeared for a run that never had one')
  assert.equal(said.gap, COPY.runNothingSaved, 'a run with nothing saved shows a blank instead of a sentence')
  assert.ok(said.gap.length > 0)
})

/* THE PAIR THAT ACTUALLY APPEARED ON THE GLASS, and it is the same shape as the
 * pair this whole screen was rewritten to make unreachable.
 *
 * MEASURED, on a packaged build, with a real Claude agent
 * (tools/home-activity-substance-qa.mjs part B): the run reached the signed
 * record the instant it started, the tree's NODE reached saved storage a beat
 * later, and in that gap the row showed
 *
 *     Said back: Cormorant.
 *     No brief and no answer were saved here for this one.
 *
 * Both sentences were true of different sources. Together they were nonsense,
 * printed by the screen whose one job is that no two of its sentences can
 * contradict. An answer therefore outranks every absence, whichever source it
 * came from. */
test('a row never shows an answer and a sentence saying nothing was saved', () => {
  const live = describeRun(RUN({ sessionId: 'chat-brandnew' }), SAVED(), NOW, { live: { working: true, text: 'Cormorant.' } })
  assert.equal(live.said, 'Cormorant.')
  assert.equal(live.gap, '',
    'the row prints the agent’s own words above a sentence saying no answer was saved for it')

  /* And the absence is still said when there really is nothing: the repair must
     not be "never say it". */
  const empty = describeRun(RUN({ sessionId: 'chat-brandnew' }), SAVED(), NOW)
  assert.equal(empty.gap, COPY.runNothingSaved, 'the sentence was removed rather than ordered')
})

test('a started run that has said nothing yet is told apart from one that said nothing at all', () => {
  const running = describeRun(RUN(), SAVED({ status: 'running' }), NOW)
  assert.equal(running.gap, COPY.runNoAnswerYet, 'a working agent is reported as having finished silently')
  const done = describeRun(RUN(), SAVED({ status: 'finished' }), NOW)
  assert.equal(done.gap, COPY.runNoAnswerSaved, 'a finished run with no answer says nothing about it')
  assert.notEqual(COPY.runNoAnswerYet, COPY.runNoAnswerSaved, 'the two absences say the same thing')
})

test('a refused run is not asked why it never answered', () => {
  const said = describeRun(RUN({ result: 'refused', reason: 'AGENT_TIER_NO_LAUNCHER' }), SAVED(), NOW)
  assert.equal(said.gap, '', 'a run that never started was reported as one that answered nothing')
  assert.equal(said.noWork, '', 'a run that never started was told it recorded no turns')
  assert.ok(said.why.length > 0, 'the refusal lost its reason')
})

/* ---- what it did, out of the per-turn record ---- */

const TURN = (over = {}) => ({ sessionId: 'chat-a', basis: 'turn', tier: 'claude-sonnet', status: 'success', totalTokens: 1000, ...over })

test('what a run did is counted off the turn record and named in words', () => {
  const work = summariseRunWork([TURN(), TURN({ totalTokens: 2500 })])
  assert.deepEqual({ ...work }, { turns: 2, model: 'Sonnet', tokens: 3500, unfinished: 0 })
  const said = describeRun(RUN(), SAVED(), NOW, { work })
  assert.match(said.did, /2 turns on Sonnet/, 'the row does not say what the run did')
  assert.match(said.did, /3,500 tokens/, 'the figures the record holds are not on the row')
  assert.equal(said.noWork, '', 'a run with turns was told it had none')
})

/* THE ARITHMETIC THAT WOULD MULTIPLY A SESSION'S SPEND BY ITS NUMBER OF TURNS.
   A `session-total` row is the engine's RUNNING total, and codex emits one
   several times a turn. Summing them is how a page prints a confident,
   enormous, wrong number. */
test('a running total is taken at its largest and never added up', () => {
  const work = summariseRunWork([
    TURN({ basis: 'session-total', totalTokens: 900 }),
    TURN({ basis: 'session-total', totalTokens: 2400 }),
  ])
  assert.equal(work.tokens, 2400, 'a running total was summed, so the row reports spend that never happened')
  assert.equal(work.turns, 2)
})

/* THE ALLOWLIST THAT KEEPS A GOOD CLAUDE TURN FROM READING AS A FAILURE. The
   two engines do not use the same word: codex says "completed", the Claude CLI
   says "success". Both are successes and neither is a failure. */
test('each engine’s own word for a turn that went well is read as one', () => {
  assert.equal(summariseRunWork([TURN({ status: 'completed' }), TURN({ status: 'success' })]).unfinished, 0,
    'one of the two engines has its successful turns counted as failures')
  assert.equal(summariseRunWork([TURN({ status: 'error' })]).unfinished, 1, 'a failed turn was counted as a good one')
})

/* A turn nobody wrote an ending for is not a turn that failed. That direction
   is the one that lies to a person about their own agent. */
test('a turn with no recorded ending is not counted as a turn that failed', () => {
  assert.equal(summariseRunWork([TURN({ status: null }), TURN({ status: '' })]).unfinished, 0,
    'turns whose ending was never recorded were reported as turns that did not finish')
})

/* MEASURED ON THE GLASS with a real Claude agent: a row carried "Working now"
   in green and, one line below, "No turns were recorded for it." The turn
   record is written when a turn ENDS, so both sentences were true, and together
   they read as the screen arguing with itself about an agent the person could
   watch typing. */
test('a run that is working right now is not told its turns were never recorded', () => {
  const said = describeRun(RUN(), SAVED(), NOW, { work: null, live: { working: true, text: 'Counting' } })
  assert.equal(said.working, true)
  assert.equal(said.noWork, '', 'a turn in progress is reported as a turn nobody recorded')
  /* And the sentence is still there for a run that really finished with none. */
  assert.equal(describeRun(RUN(), SAVED(), NOW, { work: null }).noWork, COPY.runNoTurns,
    'the sentence was removed rather than gated on the one state it is wrong in')
})

test('a run whose turns were never recorded says that, rather than leaving the line blank', () => {
  assert.equal(summariseRunWork([]), null)
  const said = describeRun(RUN(), SAVED(), NOW, { work: null })
  assert.equal(said.did, '')
  assert.equal(said.noWork, COPY.runNoTurns, 'a started run with no turn record shows nothing at all there')
})

/* ---- the thing this screen refuses to show, and says it refuses ---- */

/* THE RECORD HOLDS TWO LINES PER RUN: the intent before the process exists, and
 * started-or-refused the instant the start resolved. There is no ending
 * anywhere in the chain, so a duration on these rows could only be this window
 * subtracting one clock from another and calling it a measurement. It is not
 * shown, and the list says once that it is not shown. */
test('no run claims a duration or a finished state, because no ending is recorded', () => {
  const said = describeRun(RUN(), SAVED({ reply: 'Done.' }), NOW, { work: summariseRunWork([TURN()]) })
  const everything = [said.did, said.said, said.gap, said.noWork, said.resultWord, said.when].join(' ')
  for (const pattern of [/\bran for\b/i, /\btook \d/i, /\blasted\b/i, /\bfinished in\b/i, /\bduration\b/i]) {
    assert.doesNotMatch(everything, pattern, `a run claimed a length nothing recorded: ${JSON.stringify(everything)}`)
  }
  const view = describeHome({
    fleetConfigured: false,
    sessions: readLocalSessions(historyReplyWithOutcomes(['started'])),
    engine: readAgentEngine({ ok: true }),
    nowMs: NOW,
  })
  /* And the list no longer explains the omission in a paragraph under itself:
     the owner called that paragraph pointless, and it is gone on every record
     that checks out. No sentence on the screen claims a length either way. */
  assert.equal(view.panel.footer, null, 'a healthy record grew a footer paragraph again')
  for (const sentence of view.statements) {
    assert.doesNotMatch(sentence, /how long a run took|\bduration\b/i)
  }
})

/* ------------------------------------------------------------------
   THE LINES BETWEEN THE QUESTION AND THE ANSWER, for the row's open body.
   The saved transcript is the whole conversation; the row already prints
   its first line as "Asked:" and its last agent line as "Said back:", so
   describeRun trims exactly those two and no others.
   ------------------------------------------------------------------ */

test('the lines between drop the brief and the answer, which the row already prints', () => {
  const turns = [
    { who: 'you', text: 'Assist the coordinator and check in first.', at: 1 },
    { who: 'action', text: 'read the plan', at: 2 },
    { who: 'agent', text: 'Checking in before I start.', at: 3 },
    { who: 'agent', text: 'Done. Two files changed.', at: 4 },
  ]
  const said = describeRun(RUN(), SAVED({ reply: 'Done. Two files changed.', turns }), NOW)
  assert.deepEqual(said.turns.map(line => [line.who, line.text]), [
    ['action', 'read the plan'],
    ['agent', 'Checking in before I start.'],
  ])
  assert.match(said.said, /Two files changed/)
  assert.equal(said.asked, 'Assist the coordinator and check in first.')

  /* A leading you-line that is NOT the brief is a real line and stays. */
  const different = describeRun(RUN(), SAVED({ turns: [{ who: 'you', text: 'Something else entirely.' }, { who: 'agent', text: 'Right.' }] }), NOW)
  assert.deepEqual(different.turns.map(line => line.text), ['Something else entirely.'])

  /* No transcript, no lines, and never an invented one. */
  assert.deepEqual(describeRun(RUN(), SAVED(), NOW).turns, [])
  assert.deepEqual(describeRun(RUN(), null, NOW).turns, [])
  assert.deepEqual(describeRun(RUN(), SAVED({ turns: 'not a list' }), NOW).turns, [])
  /* Every line is labelled by one of the three speakers the record allows. */
  const odd = describeRun(RUN(), SAVED({ turns: [{ who: 'someone', text: 'a line' }, { who: 'agent', text: 'the answer' }] }), NOW)
  assert.deepEqual(odd.turns.map(line => line.who), ['agent'])
})

test('the copy that does not come from the decision follows the same rules', () => {
  const strings = everyCopyString(COPY)
  assert.ok(strings.length >= 12, `expected the whole set, walked ${strings.length}`)
  for (const [path, sentence] of strings) {
    assert.equal(typeof sentence, 'string')
    if (!DELIBERATELY_SILENT.has(path)) assert.ok(sentence.length > 0, `${path} is empty`)
    for (const pattern of INTERNAL_VOCABULARY) {
      assert.doesNotMatch(sentence, pattern, `${path} names a mechanism: ${JSON.stringify(sentence)}`)
    }
    for (const [character, name] of README_PUNCTUATION) {
      assert.ok(!sentence.includes(character), `${path} carries a ${name}: ${JSON.stringify(sentence)}`)
    }
    const shouted = sentence.match(/\b[A-Z]{3,}\b/g)
    assert.equal(shouted, null, `${path} shouts: ${JSON.stringify(shouted)}`)
  }
})

/* THE ASSERTION THAT MAKES THE ONE ABOVE WORTH HAVING.
 *
 * A copy module only helps if something checks the view actually uses it. The
 * first-run lane put this exactly right, about its own routing code, and it
 * described this file's gap precisely: helpers existing while one call site
 * still names a literal is how the original defect comes back. There were
 * twelve user-facing literals left in the view when that was said, and none of
 * them were covered by anything above.
 *
 * So the view may not contain a user-facing string literal at all. The check is
 * narrow on purpose -- it looks at the places text reaches a person (textContent,
 * the notice helper, an input's placeholder) rather than banning literals
 * generally, because class names, hrefs and markup are literals too and should
 * stay that way. */
test('the view contains no user-facing string literal of its own', () => {
  const body = code(HOME_JS)
  const smells = [
    [/\.textContent\s*=\s*['"`]/, 'text assigned to an element from a literal'],
    [/showNotice\(\s*['"`]/, 'a notice built from a literal'],
    /* Whitespace before `=` is required, and that is the whole difference
       between a JavaScript assignment (`const placeholder = '...'`, which is
       copy) and an HTML attribute inside a template (`placeholder="${...}"`,
       which is markup carrying a value from elsewhere). Without it this flagged
       the markup and would have been "fixed" by weakening the rule. */
    [/placeholder\s+=\s*['"`]/, 'an input labelled from a literal'],
    [/addTurn\([^)]*,\s*['"][^'"]{12,}/, 'a transcript line written from a literal'],
  ]
  for (const [pattern, what] of smells) {
    const found = body.match(new RegExp(pattern.source, 'g'))
    assert.equal(found, null, `${what} in src/views/home.js: ${JSON.stringify(found)} -- put it in COPY`)
  }
  assert.match(HOME_JS, /^\s*COPY,$/m, 'and the view imports the copy it is required to use')
})

/* ------------------------------------------------------------------
   3. The clock is never broken.
   ------------------------------------------------------------------ */

test('the clock is either a real instant or absent, never a row of placeholders', () => {
  for (const { label, input } of ALL) {
    const { clock } = describeHome(input)
    assert.ok(
      clock === null || (Number.isFinite(clock) && clock > 0),
      `clock is neither a real instant nor absent with ${label}: ${String(clock)}`,
    )
  }
})

test('a screen with nothing to count shows no clock at all', () => {
  const idle = describeHome({
    fleetConfigured: false,
    sessions: readLocalSessions({ ok: true, total: 0, verified: true, entries: [] }),
    engine: readAgentEngine({ ok: true }),
    nowMs: NOW,
  })
  assert.equal(idle.mode, HOME_MODES.LOCAL_IDLE)
  assert.equal(idle.clock, null)

  const running = describeHome({
    fleetConfigured: false,
    sessions: readLocalSessions(historyReply(2)),
    engine: readAgentEngine({ ok: true }),
    nowMs: NOW,
  })
  assert.equal(running.mode, HOME_MODES.LOCAL)
  assert.equal(running.clock, NOW - minutes(1), 'the clock counts from the newest run on this computer')
})

/* ------------------------------------------------------------------
   4. An input that accepts nothing is never rendered.
   ------------------------------------------------------------------ */

test('the composer exists only where a message actually goes somewhere', () => {
  for (const { label, input } of ALL) {
    const view = describeHome(input)
    /* FLEET only. The example used to fake its replies from a written bag; a
       LOCAL run has no receiver here -- its real chat is the tree rail and the
       agent page, reached through the door on the row. */
    const canGoSomewhere = view.mode === HOME_MODES.FLEET
    assert.equal(view.composer, canGoSomewhere, `composer offered pointlessly with ${label}`)
  }
})

/* ------------------------------------------------------------------
   5. A sample is unmistakable; real data is never badged as one.
   ------------------------------------------------------------------ */

test('the example is the same card with its own title, and no conversation half of its own', () => {
  const view = describeHome({
    sample: true,
    sessions: readLocalSessions(historyReply(2)),
    engine: readAgentEngine({ ok: true }),
    nowMs: NOW,
  })
  assert.equal(view.mode, HOME_MODES.SAMPLE)
  assert.equal(view.panel.title, 'Activity in this example fleet')
  assert.equal(view.panel.kind, 'none', 'the example brought a separate written transcript back')
  assert.equal(view.panel.context, false)
  assert.equal(view.panel.runs, true)
  assert.equal(view.panel.footer, null)
  assert.equal(view.composer, false, 'the example composer faked its replies; it is gone')
})

test('only a demonstration carries a badge, and a demonstration always does', () => {
  for (const { label, input } of ALL) {
    const view = describeHome(input)
    if (view.mode === HOME_MODES.SAMPLE) {
      assert.ok(view.panel.badge, `an example went unlabelled with ${label}`)
      assert.match(view.panel.badge, /example/i)
      assert.match(view.headline, /example/i, 'the hero says so too, not just the panel')
    } else {
      assert.equal(view.panel.badge, null, `real data was badged as an example with ${label}`)
      assert.doesNotMatch(view.headline || '', /example/i)
    }
  }
})

test('the demonstration is reached only by asking for it', () => {
  /* The old screen showed a header reading "sample transcript" beside a badge
     reading "live source" on a live screen, because the header came from
     profile data and the badge came from the mode. Nothing but the explicit
     choice may produce a sample now. */
  for (const { input } of ALL.filter(entry => entry.input.sample === false)) {
    assert.notEqual(describeHome(input).mode, HOME_MODES.SAMPLE)
  }
  for (const { input } of ALL.filter(entry => entry.input.sample === true)) {
    assert.equal(describeHome(input).mode, HOME_MODES.SAMPLE)
  }
})

/* ------------------------------------------------------------------
   6. The individual readers.
   ------------------------------------------------------------------ */

test('three outcomes are told apart: nothing ran, nothing readable, nobody to ask', () => {
  const noHost = readLocalSessions(undefined)
  assert.equal(noHost.supported, false)
  assert.equal(noHost.readable, false)

  const unreadable = readLocalSessions({ ok: false, code: 'SPAWN_RECORD_LEDGER_UNREADABLE' })
  assert.equal(unreadable.supported, true)
  assert.equal(unreadable.readable, false)

  const empty = readLocalSessions({ ok: true, total: 0, verified: true, entries: [] })
  assert.equal(empty.supported, true)
  assert.equal(empty.readable, true)
  assert.equal(empty.runs.length, 0)

  assert.notEqual(
    describeHome({ sessions: noHost, engine: readAgentEngine(undefined), nowMs: NOW }).headline,
    describeHome({ sessions: unreadable, engine: readAgentEngine({ ok: true }), nowMs: NOW }).headline,
    'a browser and a broken record must not read as the same thing',
  )
})

test('a malformed record line is dropped, not rendered as a run', () => {
  const mixed = readLocalSessions({
    ok: true,
    total: 3,
    verified: true,
    entries: [
      { sequence: 3, at: new Date(NOW).toISOString(), action: 'agent_session_start' },
      { sequence: 2, at: 'not a date', action: 'agent_session_start' },
      { at: new Date(NOW).toISOString(), action: 'agent_session_start' },
    ],
  })
  assert.equal(mixed.runs.length, 1)
  assert.equal(mixed.total, 3, 'the count of what exists is not reduced by what could not be parsed')
})

test('elapsed time is words, never a symbol standing in for a number', () => {
  assert.equal(whenWords(0), 'just now')
  assert.equal(whenWords(minutes(1)), 'a minute ago')
  assert.equal(whenWords(minutes(9)), '9 minutes ago')
  assert.equal(whenWords(minutes(60)), 'an hour ago')
  assert.equal(whenWords(minutes(60 * 5)), '5 hours ago')
  assert.equal(whenWords(minutes(60 * 24)), 'yesterday')
  assert.equal(whenWords(minutes(60 * 24 * 4)), '4 days ago')
  assert.equal(whenWords(null), null)
  assert.equal(whenWords(Number.NaN), null)
  assert.equal(whenWords(-1), null)
})

test('what the local record proves is stated exactly, and its failure is not hidden', () => {
  const intact = describeHome({
    fleetConfigured: false,
    sessions: readLocalSessions(historyReply(3, true)),
    engine: readAgentEngine({ ok: true }),
    nowMs: NOW,
  })
  /* A RECORD THAT CHECKS OUT SAYS NOTHING. The integrity sentence used to sit
     under every healthy list; it was read as a statement about the agents (it
     once sat under three runs that all refused to start), and the owner,
     reading the whole paragraph: "this little dialog box is kind of pointless".
     So the footer is null on a healthy record, and only a record that NO
     LONGER checks out speaks. */
  assert.equal(intact.panel.footer, null, 'a healthy record grew a footer paragraph again')

  const broken = describeHome({
    fleetConfigured: false,
    sessions: readLocalSessions(historyReply(3, false)),
    engine: readAgentEngine({ ok: true }),
    nowMs: NOW,
  })
  assert.match(broken.panel.footer, /no longer checks out/i)
  assert.notEqual(broken.panel.footer, intact.panel.footer)

  /* The runs are still shown when the chain does not verify. Hiding them would
     destroy the only evidence a person has that something ran. */
  assert.equal(broken.panel.empty, null)
})

/* ------------------------------------------------------------------
   7. The renderer actually consumes the decision.

   Without this, everything above could be true of a module the screen ignores.
   ------------------------------------------------------------------ */

const HOME_JS = readFileSync(new URL('../../src/views/home.js', import.meta.url), 'utf8')
const HOME_CSS = readFileSync(new URL('../../src/home.css', import.meta.url), 'utf8')
const FLEET_PROFILE_JS = readFileSync(new URL('../../src/fleet-profile.js', import.meta.url), 'utf8')

/* Comments carry the reasoning, including quotations of the old wording, so
   they must be excluded before scanning the code for that wording. */
function code(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

/* STATE THE LIMIT OF THIS ONE PLAINLY, because a reader will otherwise take it
 * for more than it is. It reads source text. It can see that the view asks for
 * the decision and reads the right fields off it; it CANNOT see that the values
 * reaching the screen are the ones the decision returned. A first mutation round
 * proved that exactly: replacing `const view = describeHome(state)` with a
 * spread that blanked `facts` and hardcoded the panel left this test green,
 * because every pattern it looks for was still in the file.
 *
 * The assertion below is therefore tightened to the shape that plant broke --
 * the assignment must be the bare call, with nothing wrapped around it -- and
 * the real end-to-end coverage lives in tools/home-screen-qa.cjs, which reads
 * the rendered DOM of the installed application and is what actually catches a
 * renderer that has stopped rendering the decision. */
/* ==================================================================
   THE FLOW IS LIVE, AND IT IS LIVE THE WAY THE PERFORMANCE MEASUREMENT SAYS IT
   HAS TO BE.

   The refresh on window focus was REMOVED, deliberately, for a measured reason:
   reading the signed record verifies a hash chain on the same process that
   forwards output for every live agent session, and the performance lane put
   the cost of asking carelessly at ~0.9s of whole-app stall on a ledger with
   ten thousand records. So "make the list live" has exactly one safe shape --
   subscribe to the stream the window is already told everything on, and touch a
   record only when that stream says a record just changed.

   These pin that shape. They read source text, so they cannot prove the words
   reach the screen; tools/home-activity-substance-qa.mjs drives the packaged
   build for that. What they can prove is that nobody has quietly put a timer
   back.
   ================================================================== */

/* Drive the real Home through its existing in-memory mount seam. Timers
   at one second or longer are retained and fired explicitly: an idle tick
   must not reread either signed record. No filesystem or native transport. */
async function mountedHomeStream(t, { example = false } = {}) {
  const { register } = await import('node:module')
  register('./helpers/css-stub-loader.mjs', import.meta.url)
  const { installWorld, fleetFetch, settle } = await import('./lib/tree-command-real-mount.mjs')
  const world = await installWorld(fleetFetch(), { asyncFrames: true })
  if (example) world.storage.setItem('mc.example', 'on')
  const previousAgent = globalThis.mcAgent
  const later = globalThis.setTimeout, cancel = globalThis.clearTimeout
  const timers = new Map(), intervals = new Map(), listeners = new Set()
  // Sample starts are staggered within a 45-second slot. Thirty seconds
  // includes the genuine current-slot run without inventing a working row.
  let at = NOW + (example ? 30000 : 0), view, closed = false, historyReads = 0, usageReads = 0
  let history = { ok: true, verified: true, entries: [{
    sequence: 1, action: 'agent_session_start', at: new Date(NOW - 1000).toISOString(),
    sessionId: 'home-stream', details: { agentId: 'codex' },
  }] }
  t.mock.method(Date, 'now', () => at)
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
    if (ms < 1000 || !Number.isFinite(ms)) return later(fn, ms, ...args)
    const handle = { unref() {} }
    timers.set(handle, () => fn(...args))
    return handle
  })
  t.mock.method(globalThis, 'clearTimeout', handle => {
    if (!timers.delete(handle)) cancel(handle)
  })
  t.mock.method(globalThis, 'setInterval', (fn, ms, ...args) => {
    const handle = { unref() {} }
    intervals.set(handle, { ms, tick: () => fn(...args) })
    return handle
  })
  t.mock.method(globalThis, 'clearInterval', handle => { intervals.delete(handle) })
  world.bridge.history = async () => { historyReads++; return history }
  world.bridge.usage = async () => { usageReads++; return { ok: true, entries: [] } }
  world.bridge.availability = async () => ({ ok: true, available: true })
  world.bridge.onEvent = listener => { listeners.add(listener); return () => listeners.delete(listener) }
  globalThis.mcAgent = world.bridge
  const { attachPersistentVoice, resetPersistentVoice } = await import('../../src/voice-coordinator.js')
  // Voice belongs to the window, not the Home route. Establish that actual
  // owner before mounting so route teardown cannot demand its destruction.
  if (!example) attachPersistentVoice()
  const persistentListeners = new Set(listeners)
  const retire = () => { view?.destroy(); view?.el.remove(); view = null }
  const close = () => {
    if (closed) return
    closed = true
    retire()
    resetPersistentVoice()
    globalThis.mcAgent = previousAgent
    world.restore()
    timers.clear()
    intervals.clear()
  }
  t.after(close)
  const { resolveDataSource } = await import('../../src/data-source.js')
  assert.equal(await resolveDataSource(), example ? 'mock' : 'local')
  const { homeView } = await import('../../src/views/home.js')
  const mount = async reply => {
    retire()
    if (reply !== undefined) history = reply
    view = homeView()
    document.body.append(view.el)
    await settle(3)
    return view
  }
  await mount()
  return {
    get view() { return view }, mount, retire, close, listeners, persistentListeners,
    intervalCount: ms => [...intervals.values()].filter(timer => timer.ms === ms).length,
    async animate() {
      at += 2500
      for (const timer of [...intervals.values()]) if (timer.ms === 2500) timer.tick()
      await settle(2)
    },
    counts: () => ({ history: historyReads, usage: usageReads }),
    emit(event, sessionId = 'home-stream') { for (const listener of [...listeners]) listener({ sessionId, event }) },
    async painted() { await new Promise(resolve => later(resolve, 120)); await settle(2) },
    async idle() {
      at += 60000
      const due = [...timers]
      for (const [handle, tick] of due) { if (timers.delete(handle)) tick() }
      await settle(3)
    },
  }
}

test('the runs list is fed by the agent event stream, not by a poll', async t => {
  const f = await mountedHomeStream(t)
  assert.ok(f.listeners.size > 0, 'the actual mounted Home subscribes')
  const mounted = f.counts()
  assert.ok(mounted.history > 0 && mounted.usage > 0, 'both initial reads were exercised')
  for (let tick = 0; tick < 3; tick++) await f.idle()
  assert.deepEqual(f.counts(), mounted, 'idle timers never poll signed history or usage')
  assert.equal(f.intervalCount(2500), 0, 'real local records do not animate pretend work')
  const packet = (type, extra = {}) => ({ type, turnId: 'first-turn', itemId: 'one-message', ...extra })
  f.emit(packet('assistant_text_delta', { text: 'Alpha' }))
  f.emit(packet('tool_call', { tool: 'host.read_file' }))
  f.emit(packet('assistant_text_delta', { text: 'Beta' }))
  f.emit(packet('assistant_text', { text: 'AlphaBeta' }))
  await f.painted()
  const reply = f.view.el.querySelector('.run-said')
  assert.ok(reply && !reply.hidden, 'the actual stream reaches the run row')
  assert.deepEqual([...reply.querySelectorAll('p')].map(node => node.textContent), ['Alpha', 'Beta'],
    'a tool boundary separates paragraphs while the final aggregate echo adds no duplicate')
  assert.deepEqual(f.counts(), mounted, 'speech is painted without reading a record')
  f.emit(packet('turn_completed', { status: 'completed' }))
  await f.painted()
  assert.equal(f.counts().history, mounted.history, 'completion does not reread an unchanged run record')
  assert.equal(f.counts().usage, mounted.usage + 1, 'completion reads the newly written turn figures once')
  f.emit(packet('assistant_text_delta', { turnId: 'second-turn', text: 'Gamma' }))
  await f.painted()
  assert.equal(reply.textContent, 'Gamma', 'a new turn does not retain the previous turn text')
  const callbacks = [...f.listeners].filter(listener => !f.persistentListeners.has(listener)), root = f.view.el
  assert.ok(callbacks.length > 0, 'Home owns a separate stream subscription')
  f.retire()
  // Compare the stream-owned rows; an already scheduled clock digit
  // transition may still remove its outgoing decorative span.
  const retiredText = root.querySelector('.log-runs').textContent, retiredCounts = f.counts()
  assert.deepEqual(f.listeners, f.persistentListeners, 'retiring Home removes its stream; the window-owned voice listener remains')
  for (const listener of callbacks) {
    listener({ sessionId: 'late-session', event: packet('assistant_text_delta', { text: 'Late unknown' }) })
    listener({ sessionId: 'home-stream', event: packet('assistant_text_delta', { text: 'Late known' }) })
  }
  await f.painted()
  assert.equal(root.querySelector('.log-runs').textContent, retiredText)
  assert.deepEqual(f.counts(), retiredCounts, 'a held late callback cannot read or repaint the rows after disposal')
})

test('the genuine example animates and advances its own rows without reading local history', async t => {
  const f = await mountedHomeStream(t, { example: true })
  assert.deepEqual(f.counts(), { history: 0, usage: 0 })
  assert.equal(f.intervalCount(2500), 1, 'one example animation is attached')
  const actions = () => [...f.view.el.querySelectorAll('.run-action')].map(node => node.textContent).filter(Boolean).join('|')
  const stages = new Set([actions()])
  assert.ok(actions(), 'the example has a working run to animate')
  for (let tick = 0; tick < 18; tick++) { await f.animate(); stages.add(actions()) }
  assert.ok(stages.size > 1, 'the actual row advances through example turn actions')
  const beforeBeat = f.view.el.querySelector('.log-runs').textContent
  await f.idle()
  assert.notEqual(f.view.el.querySelector('.log-runs').textContent, beforeBeat, 'the heartbeat advances example records')
  assert.deepEqual(f.counts(), { history: 0, usage: 0 }, 'example animation never reads a local run or turn record')
  const root = f.view.el
  f.retire()
  assert.equal(f.intervalCount(2500), 0, 'disposal cancels the example animation')
  const retiredText = root.textContent
  await f.animate()
  await f.idle()
  assert.equal(root.textContent, retiredText, 'retired example cannot repaint')
  assert.deepEqual(f.counts(), { history: 0, usage: 0 })
})

test('one card: every row folds, remembers, and the example goes through the same rows', () => {
  const body = code(HOME_JS)
  /* The fold is a native details, pressed through the shared owned gesture and
     remembered through the shared memory -- the chat's own pair, not a copy. */
  assert.match(HOME_JS, /<details class="run-fold">/, 'the run row is no longer a disclosure')
  assert.match(body, /openMemory\(/, 'the row open state is not remembered through the shared memory')
  assert.match(body, /ownDisclosure\(/, 'the row press is not owned; a press beside the triangle opens nothing')
  /* The example feeds the same list: its own conversations and turn figures
     through the same joins, and no second renderer. */
  assert.match(body, /sampleConversations\(/, 'the example no longer has conversations of its own for the rows')
  assert.match(body, /sampleUsageRaw\(/, 'the example no longer has turn figures of its own for the rows')
  for (const gone of ['makeBag', 'scheduleArrival', 'drawReply', 'ARRIVALS', 'REPLY_ACTS']) {
    assert.ok(!body.includes(gone), `the second renderer is back: ${gone}`)
  }
  /* The mounted stream case above proves message boundaries through the
     shared accumulator, including a same-item tool boundary and final echo.
     Its helper's location is not part of this row's rendering contract. */
  /* The markup the open body needs. */
  for (const cls of ['run-brief', 'run-turns', 'run-door']) {
    assert.ok(HOME_JS.includes(cls), `the row lost its ${cls}`)
    assert.ok(HOME_CSS.includes(cls), `${cls} reaches the screen with no style of its own`)
  }
  /* THE SUBSCRIPTION DOOR IS GONE FROM THIS SCREEN, and these assertions now
     hold it gone. They used to pin its disabled-plus-reason rendering, which
     was the right contract for a control that must exist and cannot succeed.
     Owner, 2026-08-26: "i dont want to advertise subscriptions in the app" --
     and payments do not open during public beta, so it was never a hold with a
     date behind it. COPY.subscribeDoor stays defined: the /subscribe view
     still uses it to refuse honestly for anyone who reaches that route. */
  assert.doesNotMatch(body, /data-door-subscribe/, 'the home screen renders no subscription door')
  assert.doesNotMatch(body, /subscribeDoor\./, 'and wires none')
})

test('the scrollbar is hidden and the region still scrolls', () => {
  /* Owner (verbatim): "i would want to scroll bar gone (not visible, it can
     still function)". Hidden on the one scroll region, and the region keeps
     overflow-y: auto so wheel, touch and keys still move it. */
  const log = HOME_CSS.slice(HOME_CSS.indexOf('.home .session-log {'), HOME_CSS.indexOf('.home .session-log:focus-visible'))
  assert.match(log, /scrollbar-width: none/, 'the scrollbar is visible again')
  assert.match(log, /\.home \.session-log::-webkit-scrollbar \{ display: none; \}/, 'the Chromium scrollbar is visible again')
  assert.match(log, /overflow-y: auto/, 'the region no longer scrolls at all, which is not what was asked')
  assert.doesNotMatch(log, /scrollbar-width: thin/)
})

test('nothing in the view polls either signed record', () => {
  const body = code(HOME_JS)
  /* EVERY PLACE EITHER READ IS CALLED FROM, listed. A first version of this
     scanned setInterval() bodies for the two names, and a mutation that put
     both reads inside the health poll left it GREEN: the pattern stopped at the
     arrow's own bracket and never saw the body. So the check is the other way
     round -- the call sites are enumerated, and a seventh one anywhere in the
     file fails this suite whatever it is wrapped in. */
  const callSites = body.split('\n')
    .map(line => line.trim())
    .filter(line => /\bload(Sessions|Usage)\s*\(/.test(line))
  assert.deepEqual(callSites.sort(), [
    'async function loadSessions(first = false) {',
    'async function loadUsage() {',
    'if (runsWanted) void loadSessions()',
    'if (usageWanted) void loadUsage()',
    'void loadSessions()',
    'void loadSessions()',
    'void loadSessions(true)',
    'void loadUsage()',
  ], 'a signed record is read from somewhere new; the allowed callers are the mount, the coalescing gate, the sample heartbeat, and opening full activity')
  assert.match(body, /if \(subject\.kind !== 'coordinator' && historyLimit < 200\)\s*\{\s*historyLimit = 200\s*void loadSessions\(\)/,
    'the fuller history is requested once when opening activity, never from a recurring timer')

  /* The mounted stream/example cases below establish the heartbeat allowance
     with real local reads and generated sample rows. A profile being
     unconfigured does not imply example mode; pinning that guard previously
     passed while local history was being polled. */
  /* AND IT MUST BE TORN DOWN, OR IT OUTLIVES THE VIEW. Either clear is
     accepted because the heartbeat is now a self-rescheduling timeout rather
     than a fixed interval -- that is what lets it carry a phase offset, so it
     never shares a wake with the fleet-health poll, which has the same 45s
     period and is started three lines away. The guarantee did not move and is
     no longer held by a spelling alone: 'home destroy leaves no recurring read
     scheduled' in tools/test/disposal-teardown.test.mjs mounts this view,
     destroys it, and fails if ANY recurring read is still scheduled. */
  assert.match(body, /clear(?:Interval|Timeout)\(sampleTick\)/,
    'and the heartbeat must be torn down, or it outlives the view')
  assert.doesNotMatch(body, /addEventListener\(\s*'focus'/,
    'the refresh on window focus is back; it was removed for a measured ~0.9s whole-app stall')
  assert.doesNotMatch(body, /visibilitychange/,
    'a visibility refresh is the focus refresh under another name')
  assert.match(body, /LEDGER_REREAD_FLOOR_MS/,
    'the gate that keeps a burst of turn endings from becoming a burst of chain checks is gone')
})

test('a record is re-read only when the stream says that record changed', () => {
  const body = code(HOME_JS)
  const ear = body.slice(body.indexOf('const onAgentPacket'), body.indexOf('const detachAgentEvents'))
  assert.ok(ear.length > 200, 'the stream listener could not be found to check what it asks for')
  assert.match(ear, /askForLedger\(\{ runs: true \}\)/,
    'a session this list has never seen no longer asks for the run record, so a new run never appears')
  assert.match(ear, /askForLedger\(\{ usage: true \}\)/,
    'a turn that ended no longer asks for the turn record, so what a run did never updates')
  assert.doesNotMatch(ear, /loadSessions\(|loadUsage\(/,
    'the listener reads a record directly, so a busy agent verifies a hash chain per packet')

  /* AND THE SAVED CONVERSATIONS MOVE WITH THE READ, which is a defect measured
     on a real run rather than a tidiness rule. A tree-started run reaches the
     signed record a beat before its NODE reaches saved storage, so the read that
     picks the run up is usually too early for the brief, and the only later read
     was the one following a turn ending. The row kept the answer and never
     gained the question. */
  const gate = body.slice(body.indexOf('function askForLedger'), body.indexOf('const onAgentPacket'))
  assert.ok(gate.length > 200, 'the coalescing gate could not be found to check what it refreshes')
  assert.match(gate, /readConversations\(\)/,
    'a ledger read no longer re-reads the saved conversations, so a run started on the tree never gains its brief')
})

/* THE SECOND READER OF ONE RECORD, WHICH IS THE DEFECT UNDERNEATH THIS FEATURE.
 *
 * src/session-roles.js was extracted from this view's own savedConversations()
 * for the metrics page, nine hours after this screen shipped its own. The two
 * were byte-identical and this screen was never switched over, so a widening of
 * either one silently missed the other -- and the widening the owner asked for
 * is exactly this one. */
test('the view reads the shared conversation reader and keeps no private copy', () => {
  const body = code(HOME_JS)
  assert.match(body, /import \{ readSessionRoles \} from '\.\.\/session-roles\.js'/,
    'the home view no longer uses the shared reader')
  assert.doesNotMatch(body, /function savedConversations/,
    'the private second reader is back; a widening of one will silently miss the other')
  assert.doesNotMatch(body, /parseFleetTrees/,
    'the view parses the saved record itself again rather than asking the module that owns it')
  assert.match(body, /readSessionRoles\([^)]*\{ transcripts: true \}\)/,
    'the view stopped asking for the saved conversations, so a node whose reply was cleared shows no answer')
})

test('what an agent said reaches the glass through the copy module like every other sentence', () => {
  const body = code(HOME_JS)
  for (const [call, why] of [
    [/COPY\.runSaid\(/, 'what the agent said is no longer labelled by the copy module'],
    [/COPY\.runAsked\(/, 'the brief is no longer labelled by the copy module'],
    [/COPY\.runWorkingNow/, 'the live line no longer takes its words from the copy module'],
  ]) assert.match(body, call, why)
  /* The lines that must exist in the markup so a live word lands on a span
     rather than rebuilding the list under a reader. */
  for (const cls of ['run-said', 'run-did', 'run-gap', 'run-live', 'run-brief', 'run-turns', 'run-door']) {
    assert.ok(HOME_JS.includes(cls), `the row lost its ${cls} line`)
    assert.ok(HOME_CSS.includes(cls), `${cls} reaches the screen with no style of its own`)
  }
})

test('the home view renders the decision rather than composing its own copy', () => {
  assert.match(HOME_JS, /from '\.\.\/local-activity\.js'/, 'the view imports the decision')
  assert.match(
    code(HOME_JS), /\n\s*const view = describeHome\(state\)\r?\n/,
    'the decision is taken whole; anything wrapped around the call is a place to quietly replace it',
  )
  assert.equal(
    (code(HOME_JS).match(/describeHome\(/g) || []).length, 1,
    'and it is called in exactly one place, so there is one seam rather than several',
  )
  assert.match(code(HOME_JS), /view\.facts\.map/, 'the facts under the ring come from the decision')
  assert.match(code(HOME_JS), /view\.panel\.title/, 'so does the panel title')
  assert.match(code(HOME_JS), /view\.composer/, 'and whether the composer exists at all')
})

test('the wording the owner objected to is gone from the code, not merely unused', () => {
  const banned = [
    /Read-only projection/i,
    /audited bridge/i,
    /coordinator thread unavailable/i,
    /Last Health Sweep/i,
    /source unavailable/i,
    /approvals waiting/i,
    /recording durable reply/i,
    /reading live projection/i,
    /No local agent fleet host detected/i,
    /already works on this one computer/i,
  ]
  for (const source of [code(HOME_JS), code(HOME_CSS), code(FLEET_PROFILE_JS)]) {
    for (const pattern of banned) assert.doesNotMatch(source, pattern)
  }
})

test('no placeholder character stands in for a value the home view does not have', async t => {
  const f = await mountedHomeStream(t)
  for (const [name, answer] of [
    ['one recorded run', undefined],
    ['readable empty history', { ok: true, verified: true, entries: [] }],
    ['unreadable history', { ok: false, code: 'HISTORY_UNREADABLE' }],
  ]) {
    if (answer !== undefined) await f.mount(answer)
    const summary = f.view.el.querySelector('[data-agents-summary]')
    const facts = f.view.el.querySelector('.home-facts')
    assert.ok(summary && facts, name + ': actual generated copy is mounted')
    const items = [...summary.querySelectorAll('.home-agents-stat')]
    const board = f.view.el.querySelector('[data-home-agents]')
    if (name === 'one recorded run') {
      assert.equal(board.hidden, false, name + ': a real run makes the board visible')
      assert.ok(items.length > 0, name + ': the visible summary is not blank')
    } else {
      assert.equal(board.hidden, true, name + ': absent or unreadable rows do not invent a summary')
      assert.equal(items.length, 0)
    }
    for (const item of items) {
      assert.match(item.querySelector('b').textContent, /^\d+$/, name + ': each visible figure is a value')
      assert.ok(item.querySelector('span').textContent.trim(), name + ': each figure has a label')
    }
    // A separator used to parse data is not displayed copy. Inspect the
    // generated facts and stat nodes, never user or assistant message text.
    for (const [character, label] of README_PUNCTUATION) {
      assert.ok(!summary.textContent.includes(character), name + ': ' + label + ' in the summary')
      assert.ok(!facts.textContent.includes(character), name + ': ' + label + ' in the facts')
    }
  }
})

test('the clock is hidden rather than dashed when there is nothing to count', () => {
  assert.match(code(HOME_JS), /digitsEl\.hidden = true/, 'the view hides the digits')
  assert.match(
    HOME_CSS,
    /\.uring-digits\[hidden\]\s*\{[^}]*display:\s*none/,
    'and the stylesheet makes hidden win against the flex display, or the digits stay visible',
  )
})

test('home suppresses the floating notice that produced the contradictory pair', () => {
  assert.match(
    HOME_CSS,
    /body\[data-route="home"\][^{]*\.fleet-profile-notice:not\(\.is-serious\)[^{]*\{[^}]*display:\s*none/,
    'the non-serious banner is hidden on home',
  )
  assert.doesNotMatch(
    HOME_CSS,
    /body\[data-route="home"\][^{]*\.fleet-profile-notice\s*\{/,
    'but a serious one is never hidden, so the rule must carry :not(.is-serious)',
  )
})

/* ------------------------------------------------------------------
   4. A state that says the product cannot do something leads somewhere.
      (LEGACY-ONB-001)
   ------------------------------------------------------------------ */

/* THE MEASURED DEAD END, kept as a test. On a sterile profile the panel read
 * "No agents have run here yet" over "When this copy can run agents, every run
 * will show up here" and offered NO control -- on the exact screen where the
 * person had just been told their computer cannot run one. The screen was
 * correct and terminal, which is the shape of every part of this finding.
 *
 * The words are not what is asserted here; the DOOR is. Home is barred from
 * carrying the explanation by the vocabulary and fact-cap rules above, both
 * rightly, and that is exactly why it owes a way to the page that can. */
test('a screen that cannot run agents offers a way to find out what it needs', () => {
  const blocked = describeHome({
    fleetConfigured: false,
    sessions: readLocalSessions({ ok: true, total: 0, verified: true, entries: [] }),
    engine: readAgentEngine({ ok: false, code: 'AGENT_CODEX_CLI_NOT_INSTALLED' }),
    nowMs: NOW,
  })
  assert.equal(blocked.panel.empty.action?.href, GUIDE_HREF,
    'the empty panel on a blocked machine leads nowhere')

  /* The other two branches are unchanged and must stay that way: a ready engine
     with sessions switched off is told where the switch is, and a ready engine
     with sessions already on is told nothing, because a button repeating what
     the person just did is clutter. */
  const readySwitchOff = describeHome({
    fleetConfigured: false,
    sessions: readLocalSessions({ ok: true, total: 0, verified: true, entries: [] }),
    engine: readAgentEngine({ ok: true }, false),
    nowMs: NOW,
  })
  /* THE ADDRESS CARRIES THE SWITCH'S ID, and that is the assertion rather than
     the bare route. A link that only says "#/settings" is satisfied by dropping
     somebody at the top of a 219-control page with the row they want 10170px
     below them, inside a collapsed tier -- measured on the packaged build. */
  assert.equal(readySwitchOff.panel.empty.action?.href, '#/settings?setting=write_agent-session')
  const readySwitchOn = describeHome({
    fleetConfigured: false,
    sessions: readLocalSessions({ ok: true, total: 0, verified: true, entries: [] }),
    engine: readAgentEngine({ ok: true }, true),
    nowMs: NOW,
  })
  assert.equal(readySwitchOn.panel.empty.action, null)
})

test('the sentence about other computers is a link, in every state where it is a dead end', () => {
  /* "Nothing has been heard from them recently" is a terminal statement: true,
     unexplained, and with nowhere to take it. The wording does not change -- it
     was right -- but the row leads somewhere. A reachable state that says it and
     carries no href is the defect coming back. */
  let checked = 0
  for (const { label, input } of ALL) {
    const { facts } = describeHome(input)
    for (const fact of facts) {
      if (fact.id !== 'peer') continue
      if (!/nothing has been heard from them/i.test(fact.text)) continue
      assert.equal(fact.href, GUIDE_HREF, `a terminal statement with no way out, with ${label}`)
      checked += 1
    }
  }
  /* A loop that matched nothing would pass silently, which is the same as not
     having written it. */
  assert.ok(checked > 0, 'the matrix never reached the state this test is about')
})

/* ---- THE ROW THE OWNER COULD NOT FIND A DOOR FROM ---------------------------
 *
 * "as a user I dont even see how after signing up that I now connect my
 * computer." Three scouts converged on the same finding: the connect screen
 * exists, works end to end, and had no caller anywhere in src/. The home row
 * that mentioned a second computer led to the guide, whose account content is
 * about Codex and Claude folders and which states in as many words that
 * connecting is impossible.
 *
 * These three assertions are the whole of the repair as it lands on this
 * screen, and the third is the one that is easiest to lose later: a window that
 * has NOT asked must not print a verdict either way. */
test('the account row leads to the connect screen and never guesses', () => {
  const base = {
    fleetConfigured: false,
    sessions: readLocalSessions({ ok: true, total: 0, verified: true, entries: [] }),
    engine: readAgentEngine({ ok: true }),
    nowMs: NOW,
  }
  const rowOf = account => describeHome({ ...base, account }).facts.find(fact => fact.id === 'account')

  for (const [label, account] of [
    ['nobody asked', null],
    ['asked and refused', { known: false, connected: false }],
    ['joined', { known: true, connected: true }],
    ['not joined', { known: true, connected: false }],
  ]) {
    const row = rowOf(account)
    assert.ok(row, `no account row at all with ${label}`)
    assert.equal(row.href, '#/settings?setting=connect_computer', `the account row led nowhere with ${label}`)
  }

  assert.match(rowOf({ known: true, connected: true }).text, /is on your ToolsEnabled account/i)
  assert.match(rowOf({ known: true, connected: false }).text, /is not on your ToolsEnabled account yet/i)
  /* An unread answer is not a no. This file's engine row was repaired for
     exactly this error in the other direction, and the rule is the same one. */
  for (const unread of [null, { known: false, connected: false }]) {
    const text = rowOf(unread).text
    assert.doesNotMatch(text, /is not on your ToolsEnabled account yet/i, 'an unread answer was rendered as a no')
    assert.doesNotMatch(text, /is on your ToolsEnabled account/i, 'an unread answer was rendered as a yes')
  }
})

/* ---- "AGENTS CAN RUN ON THIS COMPUTER" IS A CLAIM ABOUT THE COMPUTER --------
 *
 * It was rendered from mcAgent.availability(), which answers a question about
 * the INSTALLATION: shell/agent-host.cjs opens it when a Claude start is
 * genuinely possible -- the payload carrying the engine plus the `claude`
 * program resolving -- and never on any sign-in, because Claude's sign-in file
 * is presence-only and can never be a proof. That decision is right and is not
 * being changed: it stops the product calling itself broken on a machine that is
 * correctly set up for Claude.
 *
 * DRIVEN ON THE PACKAGED BUILD, cold install, three arms:
 *   codex signed out, claude installed       availability ok  -> "Agents can run on this computer"
 *   codex signed out, claude SIGNED IN       availability ok  -> identical, and TRUE: one can
 *   codex signed out, claude NOT INSTALLED   availability no  -> "Not ready yet", correct
 *
 * The middle arm is why this is a third state and not an inversion. The first is
 * the defect: nothing signed in to either provider and a green tick, while the
 * setup review one screen earlier says an agent cannot yet run and the press
 * then refuses for that exact reason.
 *
 * The rule this broke is already written down in this codebase -- 'unknown' IS A
 * REAL ANSWER AND IS NEVER ROUNDED UP. engineAvailability() honours it in the
 * refusal direction; home took the resulting non-refusal and rounded it up.
 * ------------------------------------------------------------------------- */

const engineFact = input => describeHome({ fleetConfigured: false, nowMs: NOW, ...input })
  .facts.find(fact => fact.id === 'engine')

const presence = rows => providerSignInReading({ ok: true, providers: rows })
const CODEX_OUT = { id: 'codex', installed: 'yes', signedIn: 'no' }
const CLAUDE_THERE = { id: 'claude', installed: 'yes', signedIn: 'unknown' }
const CLAUDE_IN = { id: 'claude', installed: 'yes', signedIn: 'yes' }

test('account-free Local readiness is not rendered as a Codex setup requirement', () => {
  const engine = readAgentEngine({ ok: true, code: 'AGENT_ENGINE_READY', readyProvider: 'local', codexCode: 'AGENT_CONFINEMENT_SIGNED_OUT' })
  const fact = engineFact({ engine, providers: presence([CODEX_OUT]) })
  assert.equal(fact.tone, 'good')
  assert.match(fact.text, /Local/)
  assert.doesNotMatch(fact.text, /codex login|nobody is signed in/i)
  const refused = engineFact({ engine: readAgentEngine({ ok: false, code: 'AGENT_CONFINEMENT_UNAVAILABLE', readyProvider: 'local' }), providers: presence([CODEX_OUT]) })
  assert.equal(refused.tone, 'warn')
})

test('hosted alternatives do not inherit a Codex requirement or Local account-free claim', () => {
  for (const readyProvider of ['claude', 'gemini', 'grok', 'antigravity']) {
    const engine = readAgentEngine({ ok: true, readyProvider, codexCode: 'AGENT_CONFINEMENT_SIGNED_OUT' })
    const fact = engineFact({ engine, providers: presence([CODEX_OUT]) })
    assert.equal(fact.tone, 'neutral')
    assert.match(fact.text, /Check its sign-in/)
    assert.doesNotMatch(fact.text, /codex login|Local|without.*sign-in/)
  }
})

test('nothing signed in anywhere is not "agents can run on this computer"', () => {
  const fact = engineFact({ engine: readAgentEngine({ ok: true }), providers: presence([CODEX_OUT, CLAUDE_THERE]) })
  assert.notEqual(fact.text, 'Agents can run on this computer',
    'a green tick on a computer where nothing is signed in to either provider')
  assert.equal(fact.tone, 'warn')
  /* It must still say what IS true -- the installation can start one -- or this
     trades a false green for a false red. */
  assert.match(fact.text, /can start an agent/i)
  assert.match(fact.text, /nobody is signed in to Codex/i)
  assert.match(fact.text, /codex login/i, 'a state with something to do must say what to do')
})

test('a signed-in Claude keeps the green, because that computer really can run one', () => {
  /* THE ARM THAT MUST NOT MOVE. Without it, the test above also passes on a
     screen that simply stopped saying anything good -- which would tell the
     Claude user their working machine is broken, the same defect wearing the
     other sign. */
  const fact = engineFact({ engine: readAgentEngine({ ok: true }), providers: presence([CODEX_OUT, CLAUDE_IN]) })
  assert.equal(fact.text, 'Agents can run on this computer')
  assert.equal(fact.tone, 'good')
})

test('an engine that refuses still says so, in its own words', () => {
  /* The third arm, and the proof this instrument can see the fact change at all:
     it already worked, and it must keep working. */
  const fact = engineFact({ engine: readAgentEngine({ ok: false, code: 'AGENT_CONFINEMENT_SIGNED_OUT' }), providers: presence([CODEX_OUT]) })
  assert.equal(fact.tone, 'warn')
  assert.equal(fact.text, ENGINE_REASON.AGENT_CONFINEMENT_SIGNED_OUT)
})

test('a caller that never asked, or asked and learned nothing, says what it always said', () => {
  /* Every existing caller of describeHome passes no providers at all. None of
     them may acquire a warning built out of a question nobody asked. */
  for (const providers of [undefined, null, providerSignInReading(null), providerSignInReading({ ok: false }),
    providerSignInReading({ ok: true }), providerSignInReading({ ok: true, providers: [] }),
    providerSignInReading({ ok: true, providers: 'codex' })]) {
    const fact = engineFact({ engine: readAgentEngine({ ok: true }), providers })
    assert.equal(fact.text, 'Agents can run on this computer',
      `an unusable presence reply changed the screen: ${JSON.stringify(providers)}`)
    assert.equal(fact.tone, 'good')
  }
})

test('ready, with nothing proven either way, picks neither end', () => {
  /* Codex answering 'unknown' is not proof that nobody is signed in. Rounding it
     up prints the green tick this repair is for; rounding it down calls a
     working machine broken. */
  const fact = engineFact({
    engine: readAgentEngine({ ok: true }),
    providers: presence([{ id: 'codex', installed: 'yes', signedIn: 'unknown' }, CLAUDE_THERE]),
  })
  assert.equal(fact.tone, 'neutral')
  assert.match(fact.text, /can start an agent/i)
  assert.match(fact.text, /could not check/i)
  assert.doesNotMatch(fact.text, /codex login/i, 'no terminal command for somebody who may already be signed in')
})

/* MEASURED ON THE LIVE SITE, 2026-08-22, the first evening a browser drove a
 * machine: the computers page's rail said "This computer is already on your
 * account -- that is how this browser is reading it" while home, read over the
 * same relay, invited the person to "Connect this computer to your ToolsEnabled
 * account". Home's account row is read from the installed application's claim
 * child, which a browser has no handle to, so the row fell to the unread
 * invitation. Over the relay the channel is the answer: every byte came from a
 * computer on the account. This pins that loadAccount() settles the row from
 * the data source before it ever looks for the claim handle. */
test('over the relay, home says the computer is on the account instead of asking it to join', () => {
  const start = HOME_JS.indexOf('async function loadAccount()')
  assert.ok(start > 0, 'loadAccount() is gone from src/views/home.js')
  const body = HOME_JS.slice(start, HOME_JS.indexOf('\n  }\n', start))
  const relayBranch = body.indexOf("currentDataSource() === 'relay'")
  const claimRead = body.indexOf('globalThis.mcShell?.deviceClaim')
  assert.ok(relayBranch > 0, 'loadAccount() no longer asks the data source whether it is reading over the relay')
  assert.ok(claimRead > relayBranch, 'the relay answer must settle the row BEFORE the claim handle is looked for')
  assert.match(body.slice(relayBranch, claimRead), /known: true, connected: true/, 'the relay branch must settle the row as joined')
})
