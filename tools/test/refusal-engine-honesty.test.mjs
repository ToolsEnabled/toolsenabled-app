/* NO REFUSAL MAY SAY THIS BUILD LACKS AN ENGINE THIS BUILD IS CARRYING.
 *
 * THE DEFECT THIS EXISTS FOR, and it reached a customer twice in two days.
 * AGENT_TIER_NO_LAUNCHER's sentence read "this copy of ToolsEnabled does not
 * carry the part that runs Claude or local agents from a tree." It was true when
 * it was written. Then capability/src/lib/agent-engine/claude-cli-process.js
 * shipped in the payload, resolveStartTier() in shell/agent-host.cjs opened the
 * three Claude tiers on a real require() of it -- and the sentence went on
 * telling a person, on a build that runs Claude, that the build could not run
 * Claude. The identical claim had already been corrected in three places on
 * 2026-08-17 while a fourth (tierHelp, help text rather than a refusal) survived
 * because no refusal test looked at it.
 *
 * WHY A COPY TEST CANNOT BE THE GUARD. Every one of those sentences was checked
 * by a test, and every one of those tests REQUIRED the false wording -- a suite
 * pinning /Pick Luna, Terra or Sol/ and /sign-in is fine/ held the lie in place
 * on the exact day the build changed underneath it. A test that asserts a
 * sentence says a particular thing about what a build carries is a test that
 * fails the day the build is right. So this one asserts nothing about wording.
 * It asks the SHELL what this payload can start, and then refuses to find any
 * sentence claiming otherwise.
 *
 * THE AUTHORITY IS THE REAL GATE, NOT A LIST. createAgentHost() is constructed
 * against this checkout's actual payload engine, and startableTiers() runs the
 * SAME resolveStartTier() a press runs -- a require() of the engine module that
 * must export the start function. So "carried" here means exactly what it means
 * to a person pressing Start, and there is no second opinion to drift from it.
 *
 * WHAT IT DOES NOT CLAIM. It says nothing about whether an engine that is
 * carried actually answers, whether the CLI is installed on this computer, or
 * whether a sign-in exists. Those are refusals of their own with their own
 * sentences, and a sentence about the COMPUTER ("Codex is not installed on this
 * computer") is deliberately outside what this reads: the detector below only
 * fires on a claim about THIS COPY.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { UNAVAILABLE_TEXT } from '../../src/agent-availability-copy.js'
import { ENGINE_REASON } from '../../src/local-activity.js'
import {
  START_REFUSAL,
  TREE_ENGINE,
  startableProviderWords,
  tierNoLauncherSentence,
} from '../../src/fleet-tree-copy.js'
import { PROVIDER_SETUP } from '../../src/first-run-needs.js'
import { LAUNCH_TIERS } from '../../src/orchestration-controls.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const require_ = createRequire(import.meta.url)
const { createAgentHost } = require_(path.join(ROOT, 'shell', 'agent-host.cjs'))

/* The payload this checkout would ship. Named once: a second path here would be
   a second answer to "what does this build carry", which is the whole disease. */
const PAYLOAD_ENGINE = path.join(ROOT, 'capability', 'src', 'lib', 'agent-engine', 'codex-process.js')

/** Which tier ids this payload can really start, asked of the shell that decides it. */
function startableTierIds(enginePath = PAYLOAD_ENGINE) {
  const host = createAgentHost({ enginePath, defaultCwd: ROOT })
  const answer = host.startableTiers()
  assert.equal(answer.ok, true, 'the shell could not answer what this build can start')
  return new Set(answer.tiers)
}

const STARTABLE = startableTierIds()
const CARRIED = new Set(LAUNCH_TIERS.filter(tier => STARTABLE.has(tier.id)).map(tier => tier.provider))

/* Local is now a carried engine too. Inspect both its menu name and the plain
   language the refusal uses instead of silently leaving it out of this guard. */
const PROVIDER_WORD = Object.freeze({
  codex: /\bcodex\b/i,
  claude: /\bclaude\b/i,
  gemini: /\bgemini\b/i,
  grok: /\bgrok\b/i,
  local: /\blocal\b|\bon (?:this computer|that computer|the computer you are driving) itself\b/i,
})

/* A CLAIM ABOUT THIS COPY, WHICH IS THE ONLY KIND THAT CAN BE WRONG THIS WAY.
 *
 * "Codex is not installed on this computer" is about the machine and is true or
 * false independently of what the payload carries, so it must not fire this. The
 * subject has to be the build itself, which in this product's voice is always
 * "this copy" / "this build" / "this version" / "this app". */
const BUILD_ABSENCE = /\bthis (?:copy|build|version|app)\b[^.]*?(?:carries no|does not carry|has no|was built without|did not ship|will not start|cannot start|is not set up|does not have|no launcher)/i

/** Every sentence a refused person can be shown, with where it came from. */
function refusalSentences() {
  const rows = []
  const push = (where, value) => {
    if (typeof value === 'string' && value.length > 0) rows.push({ where, sentence: value })
  }
  for (const [code, text] of Object.entries(UNAVAILABLE_TEXT)) push(`UNAVAILABLE_TEXT.${code}`, text)
  for (const [code, text] of Object.entries(ENGINE_REASON)) push(`ENGINE_REASON.${code}`, text)
  for (const [key, text] of Object.entries(START_REFUSAL)) push(`START_REFUSAL.${key}`, text)
  /* THE FOURTH SURFACE, and the reason it is in this list rather than in a
     comment. The setup guide is not a refusal -- which is exactly why the last
     sweep of this claim missed the copy living there. A person reads it in the
     same sitting, about the same question, and it makes the same kind of
     statement about what the build contains. */
  for (const provider of PROVIDER_SETUP) push(`PROVIDER_SETUP.${provider.id}.doesHere`, provider.doesHere)

  /* THE FIFTH SURFACE, added at the request of the lane that repaired it. The
     tree node panel's Engine row used to be two module-local consts inside
     src/views/computers.js -- TREE_ENGINE_LABEL = 'Codex' and a note saying
     agents started from a tree run on Codex -- which is the same claim as the
     four above, wrong in the same way, and unreachable from here because a const
     inside a view is not importable. It is now DERIVED and exported (8a40242),
     so this walk can see it.

     THESE ARE FUNCTIONS OF THE PROVIDER WORDS, NOT FIXED SENTENCES, so calling
     them with an arbitrary argument would measure nothing. They are called with
     the words THIS PAYLOAD's startable set produces -- the set the shell
     answered at the top of this file -- which is the same input the panel gets
     at render time.

     WHAT THIS ADDS AND WHAT IT DOES NOT. It extends THIS file's one rule (no
     sentence may claim the build lacks an engine it carries) to cover the row.
     It deliberately does not check that the row names every startable provider:
     tools/test/tree-engine-row.test.mjs owns that, and a second opinion on one
     question is how two suites come to disagree. */
  const words = startableProviderWords([...STARTABLE])
  push('TREE_ENGINE.unrecorded', TREE_ENGINE.unrecorded)
  push('TREE_ENGINE.none', TREE_ENGINE.none)
  push('TREE_ENGINE.noneNote', TREE_ENGINE.noneNote)
  push('the Engine row label', words.join(' · '))
  push('TREE_ENGINE.note(startable words)', TREE_ENGINE.note(words))
  for (const word of words) push(`TREE_ENGINE.ran(${word})`, TREE_ENGINE.ran(word))
  return rows
}

/* WHICH engine the sentence is wrong ABOUT, not merely which one it mentions.
 *
 * The first version returned the first carried provider found anywhere in the
 * string, and the negative control caught it being wrong: a regressed Engine row
 * reading "Agents you start from this tree run on Codex. This copy cannot start
 * Claude from a tree yet." was reported as claiming no CODEX launcher, because
 * Codex is named first -- as the thing it DOES run on. The verdict was right and
 * the name in it would have sent the next reader at the wrong string. So the
 * provider is taken from after the absence phrase where there is one there, and
 * only falls back to first-mentioned when the claim names none after it. */
function namesCarriedEngine(sentence) {
  const absence = BUILD_ABSENCE.exec(sentence)
  if (!absence) return null
  const after = absence.index + absence[0].length
  /* "This copy cannot start Claude" claims a missing Claude launch path;
     "Codex is a different version ... this copy will not start a session on
     it" reports a compatibility refusal. In the latter shape the engine is
     named only before `will not start`, as the thing that IS present. Falling
     back to the whole sentence turned that subject into the allegedly absent
     provider. A start-absence claim therefore has to name its provider after
     the predicate; the other absence shapes retain the whole-sentence fallback. */
  const rest = sentence.slice(after)
  /* For `cannot start`, only the rest of THAT sentence names what cannot be
     started. A later remedy may name the installed engine again (for example
     an npm command) and is evidence of presence, not absence. */
  const sentenceEnd = rest.search(/[.!?]/)
  const scopes = [sentenceEnd === -1 ? rest : rest.slice(0, sentenceEnd)]
  if (!/\b(?:will not|cannot) start\b/i.test(absence[0])) scopes.push(sentence)
  for (const scope of scopes) {
    for (const provider of CARRIED) {
      const word = PROVIDER_WORD[provider]
      if (word && word.test(scope)) return provider
    }
  }
  return null
}

test('the shell answers what this payload can start, and it is not nothing', () => {
  /* A gate that passes because it found nothing is worse than no gate. If the
     host answers an empty set, every assertion below is vacuously true -- so
     this runs first and says so. */
  assert.ok(STARTABLE.size > 0, 'the shell says this payload can start no tier at all; nothing below would be a measurement')
  assert.ok(CARRIED.size > 0, 'no startable tier maps to a provider; the tier table and the shell have drifted')
})

test('the detector fires on the sentence that actually shipped', () => {
  /* THE POSITIVE CONTROL, and it is not optional here: every assertion in this
     file is a NEGATIVE result, and a negative result from a detector nobody
     proved works is not evidence. One synthetic sentence per carried engine,
     each in the shape the real defect took. */
  for (const provider of CARRIED) {
    const fabricated = `this copy of ToolsEnabled does not carry the part that runs ${provider} agents from a tree.`
    assert.equal(namesCarriedEngine(fabricated), provider,
      `the detector missed a refusal claiming this build has no ${provider} launcher, on a build that starts ${provider}`)
  }
  /* And it must NOT fire on a true sentence about the COMPUTER, or this gate
     would force the product to stop saying the one thing a person can act on. */
  assert.equal(namesCarriedEngine('Codex is not installed on this computer, and Codex is the program that actually runs an agent.'), null)
  /* Nor may it turn the engine named as PRESENT into an absence claim merely
     because this build refuses an incompatible protocol version. */
  assert.equal(namesCarriedEngine('the Codex here is a different version from the one this copy was built against, so it will not start a session on it. Run "npm install -g @openai/codex@0.146.1" to move to the supported version.'), null)
})

test('the tree Engine row is really being inspected, not air', () => {
  /* NON-VACUITY FOR THE ADDITION ABOVE, and it is its own test because the walk
     it guards passes trivially when the strings mention no provider at all. If
     the Engine row's sentences stopped naming any carried engine, every
     assertion about them below would go green while inspecting nothing -- the
     same "a gate that passes because it found nothing" failure this file opens
     with. It fires only in that total case; whether the row names the RIGHT set
     is tree-engine-row.test.mjs's question, not this one. */
  const words = startableProviderWords([...STARTABLE])
  const rendered = [TREE_ENGINE.note(words), ...words.map(word => TREE_ENGINE.ran(word))].join(' ')
  const named = [...CARRIED].filter(provider => PROVIDER_WORD[provider] && PROVIDER_WORD[provider].test(rendered))
  assert.ok(named.length > 0,
    `the tree Engine row names no engine this build carries, so the walk over it could never fail: "${rendered}"`)
})

test('the detector fires on the Engine row too, in the shape that string used to take', () => {
  /* The row's own history is the control. Before 8a40242 it read "Agents you
     start from this tree run on Codex ... the Claude choices ... say so when
     they cannot start yet", on a build that starts Claude. The note is a
     function now, so the way it could go wrong again is a fixed absence claim
     substituted for the derivation -- which must be caught. */
  for (const provider of CARRIED) {
    const fabricated = `Agents you start from this tree run on the type you pick. This copy cannot start ${provider} from a tree yet.`
    assert.equal(namesCarriedEngine(fabricated), provider,
      `a hardcoded Engine row claiming no ${provider} launcher would pass this walk`)
  }
})

test('no refusal claims this build lacks an engine this build carries', () => {
  const offences = []
  for (const { where, sentence } of refusalSentences()) {
    const provider = namesCarriedEngine(sentence)
    if (provider) offences.push(`${where} says this copy has no ${provider} launcher, and this payload starts ${provider}: "${sentence}"`)
  }
  assert.deepEqual(offences, [], offences.join('\n'))
})

test('the tier-specific refusal names a provider this build genuinely cannot start', () => {
  /* The other half of the same rule. tierNoLauncherSentence() DOES name a
     provider -- that is its whole job -- and it is safe only because the shell
     never raises AGENT_TIER_NO_LAUNCHER for a tier it can start. This asserts
     that pairing directly rather than trusting it: every tier the shell refuses
     gets a sentence, and no such sentence names an engine this build carries. */
  let refusedTiers = 0
  /* Keep inspecting the shipping payload. The deliberately incomplete fixture
     also exercises a real missing-launcher branch when that payload carries
     every current engine; completeness must not make this check vacuous. */
  const fixtureEngine = path.join(ROOT, 'tools', 'test', 'fixtures', 'confined-engine', 'src', 'lib', 'agent-engine', 'codex-process.js')
  const fixtureStartable = startableTierIds(fixtureEngine)
  assert.ok(fixtureStartable.size > 0, 'the fixture must retain a working launch path')
  assert.ok(LAUNCH_TIERS.some(tier => !fixtureStartable.has(tier.id)), 'the fixture must lack at least one launcher')
  for (const startable of [STARTABLE, fixtureStartable]) {
    const carried = new Set(LAUNCH_TIERS.filter(tier => startable.has(tier.id)).map(tier => tier.provider))
    for (const tier of LAUNCH_TIERS) {
      if (startable.has(tier.id)) continue
      refusedTiers += 1
      const sentence = tierNoLauncherSentence(tier.id)
      assert.ok(sentence, `${tier.id} is refused by this build and the tree has no sentence for it`)
      assert.match(sentence, PROVIDER_WORD[tier.provider], 'the refusal must name the missing provider')
      for (const provider of carried) {
        const word = PROVIDER_WORD[provider]
        assert.ok(!word || !word.test(sentence),
          `the refusal for ${tier.id} names ${provider}, which this build starts: "${sentence}"`)
      }
    }
  }
  assert.ok(refusedTiers > 0,
    'the production and fixture payloads must exercise a tier-specific refusal')
})
