/* THE TWO CONTROLS ON THE FIRST SETTINGS PAGE, AND THE BOX THEY GOVERN.
 *
 * The owner asked for two things: choose which agents' context appears in the
 * chat box, and choose whether agent runs appear there too, not at all, or on
 * their own. This file is what stops either of them quietly becoming decoration.
 *
 * WHAT IT CAN AND CANNOT SEE, said plainly because the distinction is the whole
 * reason tools/chatbox-settings-qa.mjs also exists. Everything here is a
 * statement about a pure decision: given these two settings and this machine,
 * what does the box contain. That is the half a `node --test` suite can prove
 * exhaustively, and it walks every combination rather than sampling, for the
 * same reason tools/test/home-screen.test.mjs does -- the failures worth
 * catching are combinations, not branches.
 *
 * It CANNOT see whether the settings page renders the control, whether clicking
 * it reaches the setting, or whether the box on the glass re-reads it. Source
 * text cannot see reachability: dead code matches a text search exactly as well
 * as live code does. That half is proven by driving the packaged window.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { SETTINGS_GROUPS } from '../../src/settings-presentation.js'

import {
  AGENT_MODES,
  DEFAULT_AGENT_MODE,
  DEFAULT_RUNS_MODE,
  RUNS_MODES,
  agentChoices,
  agentIdsFromTurns,
  discoverAgents,
  filterTurns,
  isAgentShown,
  normalizeSelection,
  planChatbox,
  readAgentSelection,
  readRunsMode,
  setAgentSelection,
  setRunsMode,
  toggleAgent,
} from '../../src/chatbox-feed.js'
import {
  HOME_MODES,
  describeHome,
  readAgentEngine,
  readLocalSessions,
} from '../../src/local-activity.js'

const NOW = Date.parse('2026-08-11T12:00:00.000Z')
const minutes = n => n * 60_000

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

/* A storage that behaves like the browser's, including throwing, because every
   read in the module under test is guarded and a guard nothing exercises is a
   guard nobody has checked. */
function useStorage(behaviour = {}) {
  const map = new Map()
  globalThis.localStorage = {
    getItem: key => {
      if (behaviour.throwOnRead) throw new Error('storage refused')
      return map.has(key) ? map.get(key) : null
    },
    setItem: (key, value) => {
      if (behaviour.throwOnWrite) throw new Error('storage refused')
      map.set(key, String(value))
    },
    removeItem: key => {
      if (behaviour.throwOnWrite) throw new Error('storage refused')
      map.delete(key)
    },
  }
  return map
}

/* ------------------------------------------------------------------
   1. The settings themselves.
   ------------------------------------------------------------------ */

test('the shipped defaults are the values that show the most without being asked', () => {
  const store = useStorage()
  assert.equal(readRunsMode(), DEFAULT_RUNS_MODE)
  assert.equal(readRunsMode(), 'with')
  assert.equal(readAgentSelection().mode, DEFAULT_AGENT_MODE)
  assert.equal(readAgentSelection().mode, 'all')
  assert.equal(store.size, 0, 'and an untouched machine has written nothing')
})

test('only a non-default choice is stored, so the default can move later', () => {
  const store = useStorage()
  setRunsMode('only')
  assert.equal(store.get('mc.chat.runs'), 'only')
  assert.equal(readRunsMode(), 'only')
  setRunsMode('with')
  assert.equal(store.has('mc.chat.runs'), false, 'back to the default clears the key')

  setAgentSelection({ mode: 'chosen', ids: ['luna-02'] })
  assert.deepEqual(JSON.parse(store.get('mc.chat.agents')), ['luna-02'])
  setAgentSelection({ mode: 'all' })
  assert.equal(store.has('mc.chat.agents'), false)
})

test('failed chatbox writes preserve the saved choice for retry, including restoring defaults', () => {
  const behavior = { throwOnWrite: false }
  const store = useStorage(behavior)
  for (const restoreDefault of [false, true]) {
    const previousRuns = restoreDefault ? 'only' : 'with'
    const previousAgents = restoreDefault ? { mode: 'chosen', ids: ['settings-proof'] } : { mode: 'all', ids: [] }
    const nextRuns = restoreDefault ? 'with' : 'only'
    const nextAgents = restoreDefault ? { mode: 'all' } : { mode: 'chosen', ids: ['settings-proof'] }
    setRunsMode(previousRuns)
    setAgentSelection(previousAgents)
    const before = [...store]
    behavior.throwOnWrite = true
    assert.throws(() => setRunsMode(nextRuns), /storage refused/)
    assert.throws(() => setAgentSelection(nextAgents), /storage refused/)
    assert.deepEqual([...store], before)
    assert.equal(readRunsMode(), previousRuns)
    assert.deepEqual(readAgentSelection(), previousAgents)
    behavior.throwOnWrite = false
    setRunsMode(nextRuns)
    setAgentSelection(nextAgents)
    assert.equal(readRunsMode(), nextRuns)
    assert.equal(readAgentSelection().mode, nextAgents.mode)
  }
})

test('a stored value that cannot be understood resolves to showing everything', () => {
  const store = useStorage()
  for (const bad of ['nonsense', '{]', 'null', '["  "]', JSON.stringify(['owner'])]) {
    store.set('mc.chat.agents', bad)
    assert.equal(readAgentSelection().mode, 'all', `resolved wrongly for ${bad}`)
  }
  store.set('mc.chat.runs', 'sideways')
  assert.equal(readRunsMode(), DEFAULT_RUNS_MODE)
})

test('storage that refuses still leaves a working screen', () => {
  useStorage({ throwOnRead: true, throwOnWrite: true })
  assert.equal(readRunsMode(), DEFAULT_RUNS_MODE)
  assert.equal(readAgentSelection().mode, 'all')
  assert.throws(() => setRunsMode('hidden'), /storage refused/, 'Settings must keep the failed choice pending')
})

test('deselecting the last agent survives a fresh read and keeps the person’s messages', () => {
  useStorage()
  const next = toggleAgent({ mode: 'chosen', ids: ['codex'] }, 'codex')
  setAgentSelection(next)
  assert.deepEqual(readAgentSelection(), { mode: 'chosen', ids: [] })
  const turns = [{ who: 'owner', text: 'My message' }, { who: 'codex', text: 'Agent message' }]
  assert.deepEqual(filterTurns(turns, readAgentSelection()), [turns[0]])
})

test('unticking one agent while showing everything means everything else, not only that one', () => {
  useStorage()
  const present = ['claude', 'codex', 'luna-02']
  const next = toggleAgent({ mode: 'all', ids: [] }, 'codex', present)
  assert.equal(next.mode, 'chosen')
  assert.deepEqual([...next.ids], ['claude', 'luna-02'])
  assert.equal(isAgentShown(next, 'codex'), false)
  assert.equal(isAgentShown(next, 'claude'), true)
})

test('the person and the tool line are never treated as agents', () => {
  useStorage()
  const turns = [
    { who: 'owner', text: 'what is this' },
    { who: 'act', text: 'read something' },
    { who: 'luna-02', text: 'claimed' },
  ]
  assert.deepEqual([...agentIdsFromTurns(turns)], ['luna-02'])
  const onlyOther = normalizeSelection({ mode: 'chosen', ids: ['codex'] })
  const kept = filterTurns(turns, onlyOther).map(turn => turn.who)
  assert.deepEqual(kept, ['owner', 'act'], 'the person keeps their own words in their own box')
  assert.deepEqual([...normalizeSelection({ mode: 'chosen', ids: ['owner', 'act'] }).ids], [])
})

/* ------------------------------------------------------------------
   2. Finding out which agents there are.
   ------------------------------------------------------------------ */

test('a fresh install with no sources knows no agents, and that is not an error', () => {
  assert.deepEqual(discoverAgents({}), [])
  assert.deepEqual(discoverAgents({ register: null, turns: [], speakers: null }), [])
  assert.deepEqual(agentChoices([], { mode: 'all', ids: [] }), [])
})

test('agents are found in every source the product already has', () => {
  const found = discoverAgents({
    register: { agents: [{ id: 'terra-01', displayName: 'terra' }] },
    turns: [{ sender: 'codex-b', text: 'hello' }, { sender: 'owner', text: 'hi' }],
    speakers: {
      owner: { cls: 'is-owner', label: 'owner' },
      act: { cls: 'is-act', label: '' },
      'luna-02': { cls: 'is-agent', label: 'luna-02' },
    },
  })
  /* Sorted by the name a person reads, not by the identifier: the register's
     display name is what the settings list shows. */
  assert.deepEqual(found.map(agent => agent.name), ['codex-b', 'luna-02', 'terra'])
  assert.deepEqual(found.map(agent => agent.id), ['codex-b', 'luna-02', 'terra-01'])
  assert.equal(found.every(agent => agent.present), true)
})

test('an agent that appears later is included by "every agent" and excluded by a picked list', () => {
  const before = normalizeSelection({ mode: 'chosen', ids: ['claude'] })
  assert.equal(isAgentShown({ mode: 'all', ids: [] }, 'brand-new'), true)
  assert.equal(isAgentShown(before, 'brand-new'), false)

  const rows = agentChoices([{ id: 'claude', name: 'claude', present: true }, { id: 'brand-new', name: 'brand-new', present: true }], before)
  assert.deepEqual(rows.map(row => [row.id, row.chosen]), [['claude', true], ['brand-new', false]])
})

test('an agent that disappears while selected keeps its place and its tick', () => {
  const selection = normalizeSelection({ mode: 'chosen', ids: ['claude', 'retired-one'] })
  const rows = agentChoices([{ id: 'claude', name: 'claude', present: true }], selection)
  const gone = rows.find(row => row.id === 'retired-one')
  assert.ok(gone, 'the selected agent is still offered')
  assert.equal(gone.chosen, true)
  assert.equal(gone.present, false, 'and is marked as not being here now')
})

/* ------------------------------------------------------------------
   3. What the box contains. Every combination.
   ------------------------------------------------------------------ */

const SELECTIONS = [
  ['every agent', { mode: 'all', ids: [] }],
  ['one of them', { mode: 'chosen', ids: ['codex'] }],
  ['one that is not talking', { mode: 'chosen', ids: ['nobody-here'] }],
]

const SPEAKING = [
  ['nobody', []],
  ['one agent', ['codex']],
  ['several', ['codex', 'luna-02', 'terra-01']],
]

const SESSION_INPUTS = [
  ['no shell to ask', undefined],
  ['asked, unreadable', { ok: false, code: 'SPAWN_RECORD_LEDGER_UNREADABLE' }],
  ['no runs yet', { ok: true, total: 0, verified: true, entries: [] }],
  ['many runs', historyReply(7)],
]

/* Other computers connected and ANSWERING, versus connected and silent. Two
   states, not one, and the second was missing until the page 2 lane asked
   whether my walk could actually reach both sides of what it was asserting.
   It could for the kinds, and could not for this: every combination here set a
   health reading whenever a fleet was configured, so HOME_MODES.FLEET_UNREACHABLE
   was generated zero times in 432 rows. Five of the six modes were being walked
   across every value of these two settings and the sixth across none of them,
   which is the same "generates the state, asserts nothing" hole one level up --
   except here it did not even generate it. */
const HEALTH_INPUTS = [
  ['answering', { available: true, atMs: NOW - minutes(3), total: 4, ok: 4, down: 0, unknown: 0 }],
  ['silent', null],
]

function everyCombination() {
  const out = []
  for (const sample of [false, true]) {
    for (const fleetConfigured of [false, true]) {
      for (const [healthLabel, fleetHealth] of HEALTH_INPUTS) {
        for (const mode of RUNS_MODES.map(entry => entry.id)) {
          for (const [selectionLabel, selection] of SELECTIONS) {
            for (const [speakingLabel, agentsInSource] of SPEAKING) {
              for (const [sessionLabel, sessionRaw] of SESSION_INPUTS) {
                out.push({
                  label: `sample=${sample} fleet=${fleetConfigured} health=${healthLabel} runs=${mode} `
                    + `agents=${selectionLabel} talking=${speakingLabel} record=${sessionLabel}`,
                  input: {
                    sample,
                    fleetConfigured,
                    fleetHealth: fleetConfigured ? fleetHealth : null,
                    peer: null,
                    sessions: readLocalSessions(sessionRaw),
                    engine: readAgentEngine({ ok: true }),
                    approvals: { readable: true, count: 0 },
                    chatbox: { runsMode: mode, selection, agentsInSource },
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

const ALL = everyCombination()

test('the walk is a walk and not a sample', () => {
  assert.ok(ALL.length >= 200, `only ${ALL.length} combinations`)
})

test('nothing the person switched off ever appears', () => {
  for (const { label, input } of ALL) {
    const { panel } = describeHome(input)
    const mode = input.chatbox.runsMode
    if (mode === 'hidden') assert.equal(panel.runs, false, `runs shown while hidden with ${label}`)
    if (mode === 'only') assert.equal(panel.context, false, `a conversation shown while runs-only with ${label}`)
    if (panel.context) {
      assert.ok(mode !== 'only', label)
    }
  }
})

test('a conversation is only ever offered where there is one', () => {
  for (const { label, input } of ALL) {
    const view = describeHome(input)
    /* Only a reachable coordinator has a conversation to show. The example
       used to bring a written transcript of its own into this half; it now
       shows the same run rows a real machine does, with its own asks, lines
       and answers folded into each row, and no separate conversation. */
    const couldTalk = view.mode === HOME_MODES.FLEET
    if (!couldTalk) assert.equal(view.panel.context, false, `context claimed with ${label}`)
    /* The demonstration is a labelled example. This pinned panel.runs === false
       here -- the honesty rule ("this computer's record never appears inside a
       box badged as an example") implemented as the example showing no record
       at all. describeHome now substitutes the example's OWN record instead
       (src/local-activity.js, the swap above pickMode), so runs may show; what
       must still never happen is the substitution failing. That is pinned by
       the test below, which is strictly stronger than the empty box was. */
    if (view.mode === HOME_MODES.SAMPLE) {
      assert.equal(view.panel.badge, 'Example, not your data', `an example without its badge with ${label}`)
    }
  }
})

test("the example's record is its own: this computer's record cannot reach it", () => {
  /* The strongest observable form of the substitution: whatever record the
     caller passes in, the demonstration renders IDENTICALLY. If any sentence,
     count, clock or panel flag ever varied with this computer's sessions, the
     example would be leaking the real machine into a box labelled example --
     the exact failure the old runs===false rule existed to prevent. */
  const base = { sample: true, chatbox: { runsMode: 'with' }, nowMs: NOW }
  const quietMachine = describeHome({ ...base, sessions: readLocalSessions(historyReply(0)) })
  const busyMachine = describeHome({ ...base, sessions: readLocalSessions(historyReply(7)) })
  const unverified = describeHome({ ...base, sessions: readLocalSessions(historyReply(3, false)) })
  assert.deepEqual(busyMachine, quietMachine,
    "seven real runs changed the example's rendering; the substitution in describeHome is not holding")
  assert.deepEqual(unverified, quietMachine,
    "an unverifiable real record changed the example's rendering; the substitution is not holding")
  assert.equal(quietMachine.mode, HOME_MODES.SAMPLE)
  assert.equal(quietMachine.panel.badge, 'Example, not your data')
  /* And the card names whose list it is, beside the badge. */
  assert.equal(quietMachine.panel.title, 'Activity in this example fleet')
})

test('a box asked to show nothing says so, and offers the way back', () => {
  for (const { label, input } of ALL) {
    const { panel } = describeHome(input)
    if (panel.context || panel.runs) continue
    assert.ok(panel.empty, `an empty box said nothing with ${label}`)
    assert.ok(panel.empty.action?.href, `and offered no way to change it with ${label}`)
  }
})

test('being filtered to nothing is never reported as nobody talking', () => {
  /* On a fleet with a reachable coordinator -- the one place a conversation
     half exists now that the example has no transcript of its own. */
  const fleet = {
    fleetConfigured: true,
    fleetHealth: { available: true, atMs: NOW - minutes(2), total: 2, ok: 2, down: 0, unknown: 0 },
    sessions: readLocalSessions(historyReply(2)),
    engine: readAgentEngine({ ok: true }),
    nowMs: NOW,
  }
  const filtered = describeHome({
    ...fleet,
    chatbox: { runsMode: 'with', selection: { mode: 'chosen', ids: ['nobody-here'] }, agentsInSource: ['codex'] },
  })
  assert.ok(filtered.panel.contextEmpty, 'the screen says the agents talking are switched off')
  assert.equal(filtered.panel.context, true, 'and the conversation half is still the half that is on')

  const quiet = describeHome({
    ...fleet,
    chatbox: { runsMode: 'with', selection: { mode: 'all', ids: [] }, agentsInSource: [] },
  })
  assert.equal(quiet.panel.contextEmpty, null, 'and nobody talking is not reported as a filter')
})

/* THE PAIR, AND WHY THERE IS A PAIR.
 *
 * Three defects across two lanes were all the same mistake: a fact about the
 * SELECTION printed as a fact about the BOX. "None of the agents talking are
 * ones you picked" on a box deliberately showing no conversation; "3 agents are
 * being kept out of this box" beside a list of runs and nothing else. The
 * values were never wrong -- the name under-specified which of the two
 * questions it answered, so `planChatbox` now answers both, separately.
 *
 * Both halves are pinned here, because gating the raw one would have been the
 * easy fix and would have destroyed something: a person in "show only runs" who
 * is about to turn the conversation back on has a real interest in whether it
 * would show them anything, and only the ungated value can answer that. */
test('the raw selection facts hold whether or not the conversation is on screen', () => {
  const plan = planChatbox({
    contextAvailable: true,
    runsAvailable: true,
    runsMode: 'only',
    selection: { mode: 'chosen', ids: ['someone-else'] },
    agentsInSource: ['codex', 'luna-02', 'terra-01'],
  })
  assert.equal(plan.showContext, false, 'the conversation is not on screen in runs-only')
  assert.equal(plan.filteredToNothing, true, 'and turning it back on would still show nothing')
  assert.equal(plan.hiddenAgents, 3, 'and this is how many would come back if the selection widened')
})

test('the gated facts say nothing about a half that is not on screen', () => {
  const plan = planChatbox({
    contextAvailable: true,
    runsAvailable: true,
    runsMode: 'only',
    selection: { mode: 'chosen', ids: ['someone-else'] },
    agentsInSource: ['codex', 'luna-02', 'terra-01'],
  })
  assert.equal(plan.contextFilteredToNothing, false)
  assert.equal(plan.contextHiddenAgents, 0)

  const shown = planChatbox({
    contextAvailable: true,
    runsAvailable: true,
    runsMode: 'with',
    selection: { mode: 'chosen', ids: ['someone-else'] },
    agentsInSource: ['codex', 'luna-02', 'terra-01'],
  })
  assert.equal(shown.contextFilteredToNothing, true, 'and they agree with the raw ones once it is')
  assert.equal(shown.contextHiddenAgents, 3)
})

test('the box never complains about a filter over a conversation it is not showing', () => {
  for (const { label, input } of ALL) {
    const { panel } = describeHome(input)
    if (panel.context) continue
    assert.equal(panel.contextEmpty, null, `an agent-filter notice with no conversation shown, ${label}`)
    assert.equal(panel.hiddenAgents, 0, `a held-agent count with no conversation shown, ${label}`)
    assert.doesNotMatch(panel.footer || '', /kept out of this box/i, `a held-agent sentence with no conversation shown, ${label}`)
  }
})

/* TWO REPRESENTATIONS OF ONE FACT, AND NOTHING WAS HOLDING THEM TOGETHER.
 *
 * `panel.kind` says WHICH conversation to load ('conversation' or
 * 'none'); `panel.context` says WHETHER the conversation half is on screen.
 * They are the same fact wearing two names, and src/views/home.js reads them in
 * different places: renderContext() switches on `kind` to fetch the thread or
 * not, and everything else branches on `context`.
 *
 * Let them drift and the failure is silent in both directions -- a thread
 * fetched for a half that will not be drawn, or a held conversation cleared
 * while the box claims to be showing one, which paints an empty transcript with
 * no notice explaining it. Neither would fail a test: `panel.kind` was not
 * referenced by a single assertion in this suite before this one.
 *
 * That is the gap the page 2 lane named after I fixed the footer: coverage that
 * GENERATES a state and asserts nothing about it is indistinguishable from not
 * covering it. The walk below has been producing all 432 of these all along. */
test('what the box loads and what the box shows are the same fact, always', () => {
  /* Two kinds, not three: the example no longer loads a transcript of its own. */
  const KINDS = new Set(['conversation', 'none'])
  for (const { label, input } of ALL) {
    const { panel } = describeHome(input)
    assert.ok(KINDS.has(panel.kind), `unknown panel kind ${JSON.stringify(panel.kind)} with ${label}`)
    assert.equal(
      panel.kind === 'none', panel.context === false,
      `the box loads ${JSON.stringify(panel.kind)} while showing context=${panel.context}, with ${label}`,
    )
  }
})

test('the box says how many agents it is holding back, and only when it is', () => {
  const held = describeHome({
    fleetConfigured: true,
    fleetHealth: { available: true, atMs: NOW - minutes(2), total: 2, ok: 2, down: 0, unknown: 0 },
    sessions: readLocalSessions(historyReply(3)),
    engine: readAgentEngine({ ok: true }),
    chatbox: { runsMode: 'with', selection: { mode: 'chosen', ids: ['codex'] }, agentsInSource: ['codex', 'luna-02', 'terra-01'] },
    nowMs: NOW,
  })
  assert.equal(held.panel.hiddenAgents, 2)

  const nothingHeld = describeHome({
    fleetConfigured: true,
    fleetHealth: { available: true, atMs: NOW - minutes(2), total: 2, ok: 2, down: 0, unknown: 0 },
    sessions: readLocalSessions(historyReply(3)),
    engine: readAgentEngine({ ok: true }),
    chatbox: { runsMode: 'with', selection: { mode: 'all', ids: [] }, agentsInSource: ['codex', 'luna-02'] },
    nowMs: NOW,
  })
  assert.equal(nothingHeld.panel.hiddenAgents, 0)
  assert.notEqual(
    held.panel.footer,
    nothingHeld.panel.footer,
    'holding agents back does not change the footer shown to the person',
  )
})

test('an input that would post into a hidden conversation is never offered', () => {
  for (const { label, input } of ALL) {
    const view = describeHome(input)
    if (!view.panel.context) assert.equal(view.composer, false, `a composer over a hidden conversation with ${label}`)
  }
})

/* The invariants tools/test/home-screen.test.mjs proves for the shipped
   default, re-proved across every value of these two settings. Adding a control
   that can make the screen contradict itself would be adding the defect that
   file exists to prevent, one setting removed from where it looks. */
const FILLER = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'has', 'have', 'had', 'be', 'been',
  'to', 'of', 'on', 'in', 'it', 'this', 'that', 'your', 'you', 'and', 'so', 'here',
])
const normalize = statement => statement
  .toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
  .map(word => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word))
  .filter(word => !FILLER.has(word)).join(' ')

const INTERNAL_VOCABULARY = [
  /projection/i, /audited bridge/i, /coordinator thread/i, /health sweep/i,
  /source unavailable/i, /read-only/i, /envelope/i, /payload/i, /schema/i,
  /\bIPC\b/, /localhost|127\.0\.0\.1/, /subsystem/i, /durable/i, /snapshot/i,
  /\bfleet host\b/i,
]
const README_PUNCTUATION = ['·', '…', '—', '●', '→', '|']

test('no setting of these two lets the screen say the same thing twice', () => {
  for (const { label, input } of ALL) {
    const { statements } = describeHome(input)
    const normalized = statements.map(normalize)
    for (let i = 0; i < statements.length; i += 1) {
      for (let j = i + 1; j < statements.length; j += 1) {
        assert.notEqual(normalized[i], normalized[j], `${label}\n  ${statements[i]}\n  ${statements[j]}`)
      }
    }
  }
})

test('no setting of these two lets the screen talk like a README', () => {
  for (const { label, input } of ALL) {
    for (const statement of describeHome(input).statements) {
      for (const pattern of INTERNAL_VOCABULARY) {
        assert.doesNotMatch(statement, pattern, `${label}: ${JSON.stringify(statement)}`)
      }
      for (const character of README_PUNCTUATION) {
        assert.ok(!statement.includes(character), `${label}: ${JSON.stringify(statement)}`)
      }
      assert.equal(statement.match(/\b[A-Z]{3,}\b/g), null, `${label}: ${JSON.stringify(statement)}`)
    }
  }
})

test('no setting of these two states more than three facts under the ring', () => {
  for (const { label, input } of ALL) {
    assert.ok(describeHome(input).facts.length <= 3, label)
  }
})

test('the default reproduces the screen that shipped before these settings existed', () => {
  /* The property a default should have: a person who never opens this page sees
     what they saw before, and every other value is a narrowing they chose. The
     one place the default adds rather than preserves is a computer with a
     coordinator answering, where the box gains the run record it always had on
     every other computer. */
  const local = { fleetConfigured: false, sessions: readLocalSessions(historyReply(3)), engine: readAgentEngine({ ok: true }), nowMs: NOW }
  const withDefault = describeHome({ ...local, chatbox: { runsMode: DEFAULT_RUNS_MODE, selection: { mode: 'all', ids: [] }, agentsInSource: [] } })
  const withNothingSaid = describeHome(local)
  assert.deepEqual(withNothingSaid.statements, withDefault.statements)
  assert.equal(withDefault.panel.runs, true)
  assert.equal(withDefault.panel.context, false)
  assert.equal(withDefault.panel.title, 'Activity on this computer')
})

/* ------------------------------------------------------------------
   4. The controls exist on the first settings page, and are wired.

   Source text, and stated as such: this can see that the section is registered
   first and that its controller is bound, which is exactly the pair of mistakes
   that produced a settings section nobody could click. It cannot see that
   clicking one changes the box, and does not claim to.
   ------------------------------------------------------------------ */

const SETTINGS_JS = readFileSync(new URL('../../src/views/settings.js', import.meta.url), 'utf8')
const HOME_JS = readFileSync(new URL('../../src/views/home.js', import.meta.url), 'utf8')

test('both chatbox controls remain reachable in the Home screen category', () => {
  assert.equal(SETTINGS_GROUPS.flatMap(group => group.sections).filter(section => section === 'Home screen').length, 1)
  assert.match(SETTINGS_JS, /const SECTIONS = SETTINGS_GROUPS\.flatMap/)
  assert.match(SETTINGS_JS, /if \(section === CHATBOX_SECTION\) return chatboxController\.markup\(\)/)
})

test('every settings section controller on this page is actually bound', () => {
  /* The measured defect this pins down: `createSetupProfileSettings` builds a
     click handler that only `bind` attaches, and nothing called it, so every
     control in Settings -> Setup rendered and did nothing. A controller that is
     rendered but not bound is a control that cannot be used. */
  for (const controller of ['profileController', 'setupController', 'chatboxController']) {
    assert.match(SETTINGS_JS, new RegExp(`${controller}\\.bind\\(root\\)`), `${controller} is never bound`)
    assert.match(SETTINGS_JS, new RegExp(`${controller}\\.destroy\\(\\)`), `${controller} is never released`)
  }
})

test('the home view reads both settings and re-reads them when they move', () => {
  assert.match(HOME_JS, /from '\.\.\/chatbox-feed\.js'/)
  assert.match(HOME_JS, /readRunsMode\(\)/)
  assert.match(HOME_JS, /readAgentSelection\(\)/)
  assert.match(HOME_JS, /addEventListener\(CHATBOX_FEED_EVENT/, 'a setting changed on another screen has to reach this one')
  assert.match(HOME_JS, /removeEventListener\(CHATBOX_FEED_EVENT/, 'and must not outlive the view')
  assert.match(HOME_JS, /filterTurns\(contextTurns, state\.chatbox\.selection\)/, 'the filter is applied to the held conversation')
})

test('the composer is never enabled by the carrier alone, only by the switch as well', () => {
  /* Source text, and it is pinning a defect that was measured rather than
     imagined: the enable used to depend only on whether the bridge would carry
     a message, so with replying switched off -- the shipped default -- the box
     printed "Replies will be sent and recorded" over an input that discarded
     every keystroke. The order matters, so the assertion is on the order: the
     switch is checked and bails out BEFORE the carrier is asked. */
  /* 2026-09-18: the box is the shared surface's (mountSharedThread). The
     switch decides `canSend` -- and with it whether a sender exists at all --
     before the carrier is asked, and a switched-off box carries the reason. */
  const switchAt = HOME_JS.indexOf('const canSend = composerWanted && !sample && writeReplyEnabled')
  const senderAt = HOME_JS.indexOf('onSend: sender ?')
  const carrierAt = HOME_JS.indexOf('void bridgeStatus()')
  assert.ok(switchAt > 0, 'the composer never consults the reply switch')
  assert.ok(carrierAt > 0 && switchAt < carrierAt, 'the switch must be checked before the carrier is asked')
  assert.ok(senderAt > switchAt, 'no sender is wired before that check')
  assert.match(HOME_JS, /composerReason: canSend \? null : \(sample \? COPY\.exampleReadOnly : !composerWanted \? COPY\.noComposerHere : COPY\.replyDisabled\)/,
    'and the box says which switch it is waiting on')
})

test('both controls offer exactly the states the owner named', () => {
  assert.deepEqual(RUNS_MODES.map(mode => mode.id), ['with', 'hidden', 'only'])
  assert.deepEqual(AGENT_MODES.map(mode => mode.id), ['all', 'chosen'])
  for (const mode of [...RUNS_MODES, ...AGENT_MODES]) {
    assert.ok(mode.label.length > 0, `${mode.id} has no label`)
    assert.ok(mode.detail.length > 20, `${mode.id} does not say what it does`)
  }
})
