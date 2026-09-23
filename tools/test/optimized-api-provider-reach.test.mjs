// WHICH PROVIDERS THE COMPACT TOOL PATH ACTUALLY REACHES -- MEASURED, NOT ASSUMED.
//
// The compact (optimized) tool path is two things that ride the session prompt:
// the standard tool note (agent.tool_summary, enforced by the payload's
// src/lib/agent-tool-summary.js) and the per-turn recall block
// (agent.capability_recall, src/lib/capability-recall/index.js). Both are gated
// in shell/agent-host.cjs on ONE fact about the session's plan -- whether it
// wired the product's own MCP servers -- and on nothing else. Not the provider
// name, not the tier.
//
// WHAT IS ALREADY COVERED, AND SO IS NOT COVERED AGAIN HERE. Which providers
// have a LAUNCHER is already pinned: tools/test/agent-host-acp-tier.test.mjs
// iterates `for (const provider of ['gemini', 'grok'])` and asserts both refuse
// with AGENT_TIER_NO_LAUNCHER on a payload that exports no acpSessionPlan, in a
// test named "older payloads do not advertise Gemini or Grok launchers". The
// same file STUBS `planner.acpSessionPlan` a few lines above and shows both
// providers then reaching a real plan. So launcher presence is a property of
// the PAYLOAD, never of the product, and it already has coverage.
//
// WHAT WAS GENUINELY UNPINNED, and is the only thing this file adds: nothing
// asserted that a provider whose plan DOES wire servers actually receives the
// compact note and the recall block end-to-end, through the shell's own guard,
// on a plan built by the REAL planner.
// tools/test/tool-summary-injection.test.mjs proves the host's assembly on a
// HAND-WRITTEN plan -- the right shape for that suite, and the wrong shape for
// this question, because a hand-written plan cannot notice when the real planner
// changes what it wires. It had already stopped noticing: the comment at
// composeToolSummaryNote() recorded "a Claude session's plan carries
// `servers: []`" as measured fact long after claudeToolsSessionPlan() landed,
// and no suite contradicted it. The assertion that should have --
// agent-confinement-provider.test.mjs asserting plan.servers.length > 0 -- is
// silenced on the stale payload, where the test aborts first on
// plan.agentApiMode, and is Claude-only in any case: gemini, grok and local
// have no equivalent there at any base. Measured both ways by mutating > 0 to
// > 99: at the candidate that suite goes 9/0 to 8/1, on the stale payload it
// is 5/4 either way.
//
// THE INVARIANT IS THE BICONDITIONAL: the compact path reaches a provider
// exactly when that provider's plan wired servers. Deliberately NOT any
// provider's current answer, because that answer is payload-dependent and this
// file must be true of whichever payload is staged. A provider that gains or
// loses a launcher moves branch and this suite still holds; a change that let
// the note through to a session with no toolkit, or withheld it from one with a
// toolkit, fails it.
//
// THE ANTI-VACUITY CONTROLS, and there are two because this file has already
// been vacuous once.
//
//   1. A biconditional is satisfied by a planner that refuses everything, so
//      "at least one provider wires servers" is asserted separately. Without it
//      this file would go green on a payload that ships no toolkit at all.
//
//   2. THE MODE TRAP, which is the one that actually bit. The first version of
//      this file passed `agentApiMode: 'Enabled'` for every provider. Against a
//      payload that carries ACP planners, that is precisely the mode which
//      refuses Gemini and Grok BY DESIGN -- the engine's own rule, "New ACP
//      engines expose only the scoped, app-owned tool servers", refusing with
//      AGENT_ACP_REQUIRES_APP_TOOLS. So the biconditional passed, but it passed
//      on the REFUSAL branch, and the suite never exercised the default mode
//      that a session actually runs in. Green, and vacuous for three of five
//      providers. That is the same defect this file's own header describes in
//      agent-confinement-provider.test.mjs: an assertion that runs but cannot
//      reach the condition it claims to cover.
//
//      So: every mode a session can be planned in is exercised, the DEFAULT one
//      first, and `wiredInDefaultMode` below asserts the default mode is never
//      narrower than the wider mode. A future change that could only be proved
//      under `Enabled` fails that assertion instead of passing quietly.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const require_ = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/* WHICH PAYLOAD THIS RUN MEASURES, and why it is not simply ROOT/capability.
 *
 * `capability/` is DERIVED output (.gitignore "/capability/"), packed by
 * `npm run pack:capability` from the ref in private/capability-source.owner.json.
 * The payload staged in a given worktree can therefore be far behind the engine
 * a release is cut from, and WHICH PROVIDERS WIRE SERVERS IS A FACT ABOUT THAT
 * PAYLOAD. A file that could only ever read ROOT/capability could not be
 * pointed at the engine under consideration, which is how a green suite ends up
 * describing a build nobody is shipping.
 *
 * So the root is an INPUT: TOOLSENABLED_TEST_PAYLOAD_ROOT overrides, and the
 * staged payload is the default. No path is hardcoded here -- naming one would
 * bind this suite to one machine's layout. The resolved root and its recorded
 * sourceRef are printed by the first test, so every run says which payload it
 * measured rather than leaving the reader to assume. */
const PAYLOAD = process.env.TOOLSENABLED_TEST_PAYLOAD_ROOT
  ? path.resolve(process.env.TOOLSENABLED_TEST_PAYLOAD_ROOT)
  : path.join(ROOT, 'capability')

/* THE SKIP NAMES ITSELF AND ITS REASON. A worktree with no payload cannot
   answer "what does the real planner wire", and that is "could not look", not
   "nothing is wired". Reporting it as a pass would be the silent skip this
   codebase keeps re-finding. */
const PLANNER_FILE = path.join(PAYLOAD, 'src', 'lib', 'agent-session-confinement.js')
const payloadStaged = existsSync(PLANNER_FILE)
const skip = payloadStaged
  ? false
  : `no engine payload is readable at ${PAYLOAD} (looked for src/lib/agent-session-confinement.js). Stage one with "npm run pack:capability", or point TOOLSENABLED_TEST_PAYLOAD_ROOT at a packed payload. This suite measures the REAL planner and must not pass without one.`

const planner = payloadStaged ? require_(PLANNER_FILE) : null
const machineRecord = payloadStaged
  ? require_(path.join(PAYLOAD, 'src', 'lib', 'setup', 'machine-record.js'))
  : null
const { confinementPlanFor, createAgentHost } = require_(path.join(ROOT, 'shell', 'agent-host.cjs'))

const CONFINED_ENGINE = path.join(ROOT, 'tools/test/fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
/* Same reason as tool-summary-injection.test.mjs: left unset the host consults
   the real os.freemem() and every start below would track this computer's spare
   memory rather than the code under test. */
const TEST_FREE_MEMORY = () => 64 * 1024 * 1024 * 1024

/* EVERY PROVIDER PATH confinementPlanFor() routes, not just the hosted four.
   `local` is here because the compact path's reach is claimed for it too, and a
   claim nothing exercises is the defect this file exists to catch. */
const ALL_PROVIDERS = ['codex', 'claude', 'gemini', 'grok', 'local']

/* THE MODES A SESSION CAN BE PLANNED IN, DEFAULT FIRST.
 *
 * The default is what a session gets unless the owner widens it, so it is the
 * mode any claim about "what sessions receive" is about. `Enabled` is the wider
 * one, and against a payload carrying ACP planners it is the mode that refuses
 * Gemini and Grok by design -- which is exactly why testing only that mode left
 * this file green and vacuous for them. Both are exercised; neither alone is
 * allowed to stand in for the other. */
const MODES = [
  { name: 'default', options: {} },
  { name: 'wider', options: { agentApiMode: 'Enabled' } },
]

let SCRATCH_ROOT = null
if (payloadStaged) {
  const profileRoot = planner.installationProfileRoot()
  const fixtureTemp = planner.assertAccountProfilePath(
    process.platform === 'win32' ? path.join(profileRoot, 'AppData', 'Local', 'Temp') : os.tmpdir(),
    { field: 'optimized-api reach fixture temp', profileRoot, requireOwnedProfile: process.platform === 'win32' })
  SCRATCH_ROOT = mkdtempSync(path.join(fixtureTemp, 'mc-optimized-api-reach-'))
}
test.after(() => { if (SCRATCH_ROOT) rmSync(SCRATCH_ROOT, { recursive: true, force: true, maxRetries: 5 }) })

/* A whole machine in a temporary directory, the same arrangement
   agent-confinement-provider.test.mjs uses and for the same reason: the only
   thing staged is the machine, so the decision under test is the product's. */
function withMachine(tier, run) {
  const scratch = mkdtempSync(path.join(SCRATCH_ROOT, 'm-'))
  const localAppData = path.join(scratch, 'local')
  const servicesRoot = path.join(localAppData, 'ToolsEnabled')
  const workspace = path.join(scratch, 'workspace')
  const codexHome = path.join(scratch, 'codex-home')
  const claudeHome = path.join(scratch, 'claude-home')
  const geminiHome = path.join(scratch, 'gemini-home')
  const grokHome = path.join(scratch, 'grok-home')
  for (const dir of [servicesRoot, workspace, codexHome, claudeHome, geminiHome, grokHome]) mkdirSync(dir, { recursive: true })
  // Inert bytes. linkCredential() links the FILE and never reads it, so presence
  // is all the product ever knew; this proves the gate without a real sign-in.
  writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({ note: 'not a credential' }))
  writeFileSync(path.join(claudeHome, '.credentials.json'), JSON.stringify({ note: 'not a credential' }))

  const previous = {}
  for (const name of ['LOCALAPPDATA', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'TOOLSENABLED_STATE_ROOT', 'TOOLSENABLED_SETTINGS_PATH']) {
    previous[name] = process.env[name]
  }
  process.env.LOCALAPPDATA = localAppData
  process.env.CODEX_HOME = codexHome
  process.env.CLAUDE_CONFIG_DIR = claudeHome
  // Absent, test-owned settings file: the shipped defaults, never an owner's saved mode.
  process.env.TOOLSENABLED_SETTINGS_PATH = path.join(scratch, 'settings.json')
  // One level inside the services root, the shape shell/main.cjs uses.
  process.env.TOOLSENABLED_STATE_ROOT = path.join(servicesRoot, 'capability')
  try {
    machineRecord.writeMachineRecord(machineRecord.buildMachineRecord({
      tier, servicesRoot, installRoot: PAYLOAD, nodePath: process.execPath, workspaceRoots: [workspace],
    }), { servicesRoot })
    return run({
      scratch,
      codex: Object.freeze({ name: 'fixture-codex', resolvedHome: codexHome }),
      claude: Object.freeze({ name: 'fixture-claude', resolvedHome: claudeHome }),
      gemini: Object.freeze({ name: 'fixture-gemini', resolvedHome: geminiHome }),
      grok: Object.freeze({ name: 'fixture-grok', resolvedHome: grokHome }),
    })
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5 })
  }
}

/* The real plan for one hosted provider, and whether it wired the product's
   servers. `wired` is the ONLY thing the host's gate reads, so it is the only
   thing the assertions below branch on. */
function realPlanFor(provider, mode = MODES[0]) {
  return withMachine('standard', accounts => {
    /* `local` IS PASSED NO ACCOUNT, and that is the product's rule rather than a
       convenience here: its plan engine declares requiresProviderAccount false
       and REFUSES with AGENT_CONFINEMENT_ACCOUNT_INVALID when handed one. An
       earlier probe of mine supplied one anyway and read the refusal as "local
       cannot start" -- a fixture artefact reported as a product fact. Encoded
       here so this suite cannot repeat it. */
    const account = provider === 'local' ? null : (accounts[provider] || accounts.codex)
    const plan = confinementPlanFor(planner, {
      provider,
      ...(account ? { account } : {}),
      ...mode.options,
    })
    const servers = Array.isArray(plan.servers) ? plan.servers : []
    return { plan, wired: plan.ok === true && servers.length > 0, servers }
  })
}

/* Which providers wire servers in a given mode. Used by the assertions below
   AND printed as a diagnostic, so a run states the coverage it achieved rather
   than leaving a reader to assume every provider was exercised. */
function wiredIn(mode) {
  return ALL_PROVIDERS.filter(provider => realPlanFor(provider, mode).wired)
}

/* Drive the REAL host with a given plan and return the text the engine adapter
   actually received for the first turn. Asserting on what the adapter received
   -- rather than on any intermediate the host could compute and then ignore --
   is the same rule tool-summary-injection.test.mjs follows. */
async function firstTurnTextUnder(plan, words, { sessionId }) {
  const workdir = mkdtempSync(path.join(SCRATCH_ROOT, 'host-'))
  const previousPlan = process.env.MC_TEST_CONFINEMENT_PLAN
  process.env.MC_TEST_CONFINEMENT_PLAN = JSON.stringify(plan)
  try {
    const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: CONFINED_ENGINE, defaultCwd: workdir })
    await host.startSession({ sessionId })
    const engine = require_(CONFINED_ENGINE)
    const before = engine.adapterCalls.length
    await host.sendTurn({ sessionId, text: words })
    const call = engine.adapterCalls[before]
    await host.closeAll()
    return call.request.text
  } finally {
    if (previousPlan === undefined) delete process.env.MC_TEST_CONFINEMENT_PLAN
    else process.env.MC_TEST_CONFINEMENT_PLAN = previousPlan
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
}

test('the payload under test is named, and at least one provider wires its servers', { skip }, () => {
  /* THE ANTI-VACUITY CONTROL, first, because every assertion after it is only
     worth reading if this one holds. A planner that refused every provider
     would satisfy the biconditional below while shipping no tools at all. */
  let sourceRef = 'none recorded (raw engine worktree, not a packed payload)'
  try { sourceRef = JSON.parse(readFileSync(path.join(PAYLOAD, 'PAYLOAD.json'), 'utf8')).sourceRef || sourceRef } catch { /* not packed */ }
  /* EVERY RUN SAYS WHICH PAYLOAD IT MEASURED. Which providers wire servers is a
     fact about this base and no other, so a result quoted without it is the
     mistake this whole file exists downstream of. */
  console.log(`# payload root : ${PAYLOAD}`)
  console.log(`# sourceRef    : ${sourceRef}`)
  for (const mode of MODES) console.log(`# wired (${mode.name}) : ${wiredIn(mode).join(', ') || '(none)'}`)

  assert.ok(wiredIn(MODES[0]).length > 0,
    `no provider wires the product servers in the default mode against the payload at ${PAYLOAD}, `
    + 'so the compact path reaches nobody and every assertion below would pass vacuously')
})

test('the default mode is never narrower than the wider mode', { skip }, () => {
  /* THE MODE-COVERAGE CONTROL -- the one that would have caught this file's own
     defect. Its first version proved the compact path only under `Enabled`,
     which is the mode that refuses ACP providers by design, so three of five
     providers were asserted purely on the refusal branch: green, and vacuous.

     A session runs in the DEFAULT mode unless the owner widens it, so any claim
     about what sessions receive must hold there. Asserting that the default
     mode wires at least as many providers as the wider one makes a regression
     that is only demonstrable under `Enabled` fail here rather than pass
     quietly somewhere else. */
  const inDefault = wiredIn(MODES[0])
  const inWider = wiredIn(MODES[1])
  assert.ok(inDefault.length >= inWider.length,
    `the default mode wires fewer providers (${inDefault.join(', ') || 'none'}) than the wider mode `
    + `(${inWider.join(', ') || 'none'}), so a session's ordinary mode is the narrower one and any `
    + 'reach proved under the wider mode says nothing about what sessions actually receive')
  for (const provider of inWider) {
    assert.ok(inDefault.includes(provider),
      `${provider} wires servers in the wider mode but not in the default one, so its compact path `
      + 'is unreachable for an ordinary session')
  }
})

test('the compact note reaches a provider exactly when its plan wired servers, in every mode', { skip }, async () => {
  /* THE INVARIANT, asserted per provider in BOTH directions. This is the
     question the release note answered wrongly for Codex and Claude.

     A refused plan is recorded as "no session was planned", NOT as "this
     provider cannot be used". Whether a provider has a planner at all depends
     on the staged payload, and agent-host-acp-tier.test.mjs already owns that
     question. Merging the two would make this file assert a product fact it
     has not measured. */
  for (const mode of MODES) {
  for (const provider of ALL_PROVIDERS) {
    const { plan, wired } = realPlanFor(provider, mode)
    if (!plan.ok) {
      /* PROVABLY CANNOT PRODUCE THE NOTE, and for a reason that is not the
         gate: there is no plan at all, so no session starts and nothing is
         composed. Recording the refusal code keeps "could not start" distinct
         from "started and was handed nothing". */
      assert.equal(wired, false, `${provider}/${mode.name}: a refused plan must not count as wiring servers`)
      assert.ok(typeof plan.code === 'string' && plan.code.length > 0,
        `${provider}/${mode.name}: a refused plan must name its refusal, not fail silently`)
      continue
    }
    const words = `A ${provider} session asking for something ordinary.`
    const text = await firstTurnTextUnder(plan, words, { sessionId: `reach-${mode.name}-${provider}` })
    assert.ok(text.startsWith(words), `${provider}/${mode.name}: the person's own words no longer come first`)
    const carriedNote = text.length > words.length
    assert.equal(carriedNote, wired,
      wired
        ? `${provider}/${mode.name}: the plan wired servers [${plan.servers.join(', ')}] but the session was handed no compact note`
        : `${provider}/${mode.name}: the plan wired no servers, so a note would describe a toolkit the session cannot call`)
  }
  }
})

test('the owner switch still decides, for a provider whose plan did wire servers', { skip }, async () => {
  /* WIRED SERVERS ARE A PRECONDITION, NOT AN OVERRIDE. If the row being off
     stopped mattering once a provider gained a toolkit, the control would be a
     lie for exactly the sessions it matters most for. */
  const provider = wiredIn(MODES[0])[0]
  assert.ok(provider, 'no provider wires servers in the default mode, so there is nothing to drive the switch with')
  const { plan } = realPlanFor(provider)
  const words = 'The owner turned the introduction off.'

  process.env.MC_TEST_TOOL_SUMMARY = 'off'
  let offText
  try {
    offText = await firstTurnTextUnder(plan, words, { sessionId: `switch-off-${provider}` })
  } finally {
    delete process.env.MC_TEST_TOOL_SUMMARY
  }
  assert.equal(offText, words,
    `${provider}: the row is off and a note was injected anyway -- the switch is a lie`)

  const onText = await firstTurnTextUnder(plan, words, { sessionId: `switch-on-${provider}` })
  assert.ok(onText.length > words.length,
    `${provider}: the row is on and the plan wired servers, but nothing was injected`)
})

test('emptying the servers on a real hosted plan withdraws both halves of the compact path', { skip }, async () => {
  /* THE GATE ITSELF, driven on a REAL plan rather than a hand-written one: the
     same plan object, servers emptied, must lose the note AND the per-turn
     recall block. This is the direction that protects an agent from being told
     about a toolkit it cannot call. */
  const provider = wiredIn(MODES[0])[0]
  assert.ok(provider, 'no provider wires servers in the default mode, so there is nothing to empty')
  const { plan } = realPlanFor(provider)
  const words = 'Take a screenshot of the window.'

  process.env.MC_TEST_CAPABILITY_RECALL = 'on'
  try {
    const wiredText = await firstTurnTextUnder(plan, words, { sessionId: `recall-on-${provider}` })
    assert.ok(wiredText.length > words.length,
      `${provider}: a wired plan carried neither the note nor the recall block`)

    const strippedText = await firstTurnTextUnder({ ...plan, servers: [] }, words, { sessionId: `recall-empty-${provider}` })
    assert.equal(strippedText, words,
      `${provider}: servers were emptied and the session was still handed tool advice it cannot act on`)
  } finally {
    delete process.env.MC_TEST_CAPABILITY_RECALL
  }
})
