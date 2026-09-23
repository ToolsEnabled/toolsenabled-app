/* A START THAT COULD NEVER HAPPEN, REFUSED BEFORE THE PERSON WAITS FOR IT.
 *
 * WHAT HAPPENED, measured on this computer 2026-09-11. Every Grok tree start
 * refused. The launcher was present, so resolveStartTier() returned the row, so
 * startableTiers() called the Grok tiers startable, so the compose menu offered
 * them and its Start button was live. The refusal arrived four steps later from
 * the agent-session authority, whose closed actor set omitted grok, as
 * OWNER_HOST_SESSION_BINDING_INVALID -- and the copy for that code, on both
 * surfaces, ended "Reload this screen, then retry".
 *
 * The person reloaded. On a tree they had just created, they pressed Start and
 * got the identical refusal, because reloading a screen cannot add an actor to
 * a set inside the installed authority. A refusal that gives impossible advice
 * is worse than one that gives none: it spends the person's time proving the
 * product wrong.
 *
 * WHAT THIS FILE PINS.
 *   1. The app asks the authority which providers it will seat, and a tier
 *      whose provider is outside that set is refused by resolveStartTier() --
 *      which is what startableTiers() calls, so the row leaves the menu and the
 *      press never reaches the engine.
 *   2. It refuses under its OWN code. AGENT_TIER_NO_LAUNCHER means a missing
 *      program; this means a present program with no identity to run under.
 *      One code for both would make both sentences hedge.
 *   3. An authority that declares no actor set refuses NOTHING new. An older
 *      payload must not have refusals invented for it.
 *   4. Neither binding-invalid sentence tells a person to reload and retry as
 *      though that were the remedy.
 */
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const require = createRequire(import.meta.url)

import { createAgentHost, START_REFUSAL_CODES } from '../../shell/agent-host.cjs'
import { readAgentActors } from '../../shell/capability-layer.cjs'
import { LAUNCH_TIERS } from '../../src/orchestration-controls.js'
import { UNAVAILABLE_TEXT, unavailableReason } from '../../src/agent-availability-copy.js'
import { ENGINE_REASON } from '../../src/local-activity.js'
import { startRefusalSentence, tierSessionActorSentence, tierChoicesFor } from '../../src/fleet-tree-copy.js'

const GROK_TIERS = LAUNCH_TIERS.filter(row => row.provider === 'grok').map(row => row.id)

/* A host with the ACP launcher really loaded, so the ONLY thing that can refuse
   a Grok tier here is the authority's actor set. Without this the test would
   pass for the wrong reason: a missing launcher refuses too, under the other
   code, and that distinction is the whole point. */
function hostWithAcp(t, { authority }) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-actor-gate-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const root = path.join(directory, 'engine')
  cpSync(new URL('./fixtures/confined-engine/', import.meta.url), root, { recursive: true })
  const cwd = path.join(directory, 'work')
  mkdirSync(cwd)
  writeFileSync(path.join(root, 'src/lib/agent-engine/acp-process.js'),
    "module.exports={ROOT_ADMISSION_CONTRACT_VERSION:1,MODEL_SELECTION_CONTRACT_VERSION:1,"
    + "startAcpSession:async()=>({threadId:'t',adapter:{sendTurn:async()=>({turnId:'1'}),interrupt:async()=>{},answerApproval:()=>{},forkThread:async()=>({threadId:'f'})},close(){}}),"
    + "resumeAcpSession:async()=>({threadId:'t',adapter:{close(){}},close(){}})};")
  /* The fixture planner knows nothing about ACP, and without a plan a start
     refuses for a reason that has nothing to do with this gate. Supplied the
     same way tools/test/agent-host-acp-tier.test.mjs supplies it, so a start
     that gets past the gate really reaches its engine. */
  const planner = require(path.join(root, 'src/lib/agent-session-confinement.js'))
  planner.acpSessionPlan = () => ({
    ok: true, tier: 'guided', isolated: true, agentApiMode: 'Only', roleFunctionsOnly: true,
    threadOptions: { sandbox: 'read-only', approvalPolicy: 'never' }, env: {},
    configDir: path.join(directory, 'grok'), servers: ['research'], acp: { provider: 'grok' }, account: null,
  })
  const host = createAgentHost({
    enginePath: path.join(root, 'src/lib/agent-engine/codex-process.js'),
    defaultCwd: cwd,
    providerCommandResolver: id => path.join(directory, id),
    startProviderProbe: () => 'grok',
    freeMemory: () => 64 * 1024 ** 3,
    sessionAuthority: authority,
  })
  t.after(() => host.closeAll())
  return host
}

/* The shape shell/capability-layer.cjs builds from the installed owner-host
   module. bind and revoke travel together because createAgentHost refuses a
   transport that carries one without the other. */
function authorityDeclaring(actors) {
  return {
    /* An anonymous in-process binding: the shape the host accepts for a start
       that carries no declared agent id. Enough to let a start that got past
       the tier gate reach its engine, and no more. */
    bind: () => ({ bound: false, mode: 'in-process', credential: null }),
    revoke: () => ({ ok: true }),
    assert: () => ({ ok: true }),
    ...(actors ? { actorsVersion: 1, agentActors: Object.freeze(actors) } : {}),
  }
}

test('a provider the installed authority will not seat leaves the menu before a person presses Start', async t => {
  const host = hostWithAcp(t, { authority: authorityDeclaring(['codex', 'claude', 'gemini', 'local']) })
  const startable = host.startableTiers().tiers

  assert(GROK_TIERS.length >= 3, 'this build should offer several Grok rows for the gate to remove')
  for (const id of GROK_TIERS) {
    assert(!startable.includes(id), `${id} is still advertised as startable although no identity can be issued for it`)
  }
  assert(startable.includes('astra'), 'the gate must remove only the provider the authority left out')
  assert(startable.includes('gemini'), 'gemini is in the declared actor set and must stay startable')

  /* AND THE MENU SAYS SO. tierChoicesFor() is what the compose panel draws and
     what its Start button reads, so a row the shell dropped is a row the person
     cannot press -- the early refusal, on the surface they are looking at. */
  const rows = tierChoicesFor(startable)
  for (const id of GROK_TIERS) assert.equal(rows.find(row => row.id === id)?.enabled, false, id)
})

test('the refusal carries its own code and names the cause instead of a reload', async t => {
  const host = hostWithAcp(t, { authority: authorityDeclaring(['codex', 'claude', 'gemini', 'local']) })
  for (const id of GROK_TIERS) {
    assert.throws(() => host.startSession({ sessionId: `grok-${id}`, tier: id, acknowledgeLowMemory: true }), error => {
      assert.equal(error.code, 'AGENT_TIER_SESSION_ACTOR_UNSUPPORTED',
        `${id} refused as ${error.code}; a missing identity is not a missing launcher`)
      assert.match(error.message, /grok/, 'the refusal must name the provider it refused')
      assert.doesNotMatch(error.message, /[Rr]eload/, 'the cause is not something a reload can change')
      return true
    })
  }
})

test('an authority that declares no actor set refuses nothing new', async t => {
  const host = hostWithAcp(t, { authority: authorityDeclaring(null) })
  const startable = host.startableTiers().tiers
  for (const id of GROK_TIERS) {
    assert(startable.includes(id), `${id} lost its launcher because the authority declared nothing; unknown must gate nothing`)
  }
  const started = await host.startSession({ sessionId: 'grok-open', tier: 'grok', acknowledgeLowMemory: true })
  assert.equal(started.threadId, 't', 'an older payload must start exactly as it did before this gate existed')
})

test('the actor set is read from the installed module, and an unreadable one reads as unknown', () => {
  assert.deepEqual(readAgentActors({ AGENT_ACTORS: new Set(['codex', 'claude']) }), ['codex', 'claude'])
  assert.deepEqual(readAgentActors({ AGENT_ACTORS: ['codex', 'codex', 'local'] }), ['codex', 'local'])
  for (const declared of [undefined, null, new Set(), [], ['codex', 7], [''], 'codex', { codex: true }]) {
    assert.equal(readAgentActors({ AGENT_ACTORS: declared }), null, JSON.stringify(String(declared)))
  }
})

test('the new code reaches a person as a sentence on both surfaces, naming the type that was refused', () => {
  const code = 'AGENT_TIER_SESSION_ACTOR_UNSUPPORTED'
  assert(START_REFUSAL_CODES.includes(code), 'a start refusal outside the vocabulary carries no copy requirement')

  assert.ok(Object.hasOwn(UNAVAILABLE_TEXT, code))
  assert.ok(unavailableReason(code).length > 20)
  assert.ok(Object.hasOwn(ENGINE_REASON, code))

  /* The tree is the one surface that knows which type was picked, so it names
     it. Both halves are asserted: the named sentence, and the routing that
     actually produces it from a refusal. */
  const named = tierSessionActorSentence('grok-4-6')
  assert.equal(named, 'This installation cannot start a Grok agent. Update ToolsEnabled or choose another model.')
  assert.equal(tierSessionActorSentence('grok-4-6', { subject: 'the computer you are driving' }),
    'The computer you are driving cannot start a Grok agent. Update ToolsEnabled there, or choose another model.')
  assert.equal(startRefusalSentence({ code }, { tier: 'grok-4-6' }), named)
  assert.equal(tierSessionActorSentence('no-such-tier'), null,
    'an unrecognised tier must fall through to the shared sentence rather than invent a provider')

  /* AND THE LIST MAY NOT SHRINK TO FIT: the code stays in the vocabulary only
     while something really raises it. Same tie-back the other start refusals
     carry in tools/test/agent-session-surface.test.mjs. */
  const source = readFileSync(fileURLToPath(new URL('../../shell/agent-host.cjs', import.meta.url)), 'utf8')
  assert.ok(source.includes(`fail('${code}'`), `${code} is listed as a start refusal but resolveStartTier() no longer raises it`)
})

/* THE REGISTER THE OWNER ASKED FOR, held as a rule rather than as one string.
 *
 * "Keep customer-facing wording short and actionable; avoid explaining
 * app-owned session authorities or parts handing out identities in the user
 * flow; keep the precise typed reason in diagnostics; and the existing
 * unknown-identity fallback should not tell people to keep reloading."
 *
 * These are the sentences a person reads while starting an agent: the tree's
 * own named sentence, and the two shared tables behind it. Asserting the rule
 * rather than the exact words lets the wording be improved and still stops it
 * drifting back into mechanism, which is what happened once already. */
const MECHANISM_WORDS = /session authority|identity|identities|actor|bind|binding|reload|principal|seat/i

test('every sentence a person reads in the start flow stays short and actionable', () => {
  const flow = [
    ['tree, named', tierSessionActorSentence('grok-4-6')],
    ['tree, driving another computer', tierSessionActorSentence('grok-4-6', { subject: 'the computer you are driving' })],
    ['agent page, tier refused', UNAVAILABLE_TEXT.AGENT_TIER_SESSION_ACTOR_UNSUPPORTED],
    ['home, tier refused', ENGINE_REASON.AGENT_TIER_SESSION_ACTOR_UNSUPPORTED],
    ['agent page, identity unknown', UNAVAILABLE_TEXT.OWNER_HOST_SESSION_BINDING_INVALID],
    ['home, identity unknown', ENGINE_REASON.OWNER_HOST_SESSION_BINDING_INVALID],
  ]
  for (const [where, sentence] of flow) {
    assert.ok(sentence, where)
    assert.doesNotMatch(sentence, MECHANISM_WORDS,
      `${where} explains a mechanism instead of naming what to do: ${sentence}`)
    const sentences = sentence.split(/(?<=[.!?])\s+/).filter(Boolean)
    assert.ok(sentences.length <= 3, `${where} runs to ${sentences.length} sentences: ${sentence}`)
    for (const clause of sentences) {
      assert.ok(clause.split(/\s+/).length <= 18, `${where} has a clause a person has to read twice: ${clause}`)
    }
    assert.match(sentence, /Update ToolsEnabled|choose another model|Try once more/,
      `${where} says what went wrong and offers nothing to do: ${sentence}`)
  }
})

test('the unknown-identity fallback does not lead with a reload', () => {
  for (const sentence of [UNAVAILABLE_TEXT.OWNER_HOST_SESSION_BINDING_INVALID, ENGINE_REASON.OWNER_HOST_SESSION_BINDING_INVALID]) {
    /* A person followed the old "Reload this screen, then retry" on a tree they
       had just made and got the identical refusal. Removing the promise that it
       works was not enough: reload may not be the remedy this leads with, or
       lead with at all. */
    assert.doesNotMatch(sentence, /reload/i, sentence)
    assert.match(sentence, /^This agent was not started\.|^this agent was not started\./,
      'it must name what happened before it names what to do')
  }
})
