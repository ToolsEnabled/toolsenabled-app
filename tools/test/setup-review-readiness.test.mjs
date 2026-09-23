/* THE LAST SCREEN OF SETUP MAY NOT CLAIM WHAT IT HAS NOT CHECKED.
 *
 * Two defects on the same block, measured on the packaged build 2026-08-16:
 *
 *   1. The review said "Codex is installed on this computer and signed in" with
 *      Codex not on PATH and nobody signed in to it. It was branching on
 *      mcAgent.availability(), which answers a DIFFERENT question -- can this
 *      installation start any agent at all -- and that answer is yes as soon as
 *      Claude is present. The sentence flipped on the wrong program.
 *
 *   2. Because of 1, the not-installed branch -- the one carrying the line a
 *      person pastes into Windows Terminal -- was unreachable for exactly the
 *      audience it is written for.
 *
 * The short-circuit in shell/agent-host.cjs is correct and is not what changed.
 * What changed is that this block reads mcProviders.presence(), which answers
 * per program, and the tests below are per-combination because the defect was a
 * combination: engine yes, codex no.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { CODEX_SETUP_COMMANDS, codexSetupInstructions, unavailableReason } from '../../src/agent-availability-copy.js'
import { codexReadiness, localModelReadiness } from '../../src/setup-review-readiness.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const view = readFileSync(join(ROOT, 'src', 'views', 'setup.js'), 'utf8')

const said = block => block.lines.join(' ')
const CLAIM = /installed on this computer and signed in/

test('Codex setup is optional when overall readiness succeeds through another provider', () => {
  for (const installed of ['no', 'yes', 'unknown']) {
    const block = codexReadiness({ engine: { known: true, ok: true }, codex: { known: true, installed, signedIn: 'no' }, platform: 'linux', viaRelay: false })
    assert.match(block.heading, /Codex.*optional/i)
    assert.notEqual(block.tone, 'is-warn')
    if (installed !== 'unknown') assert.match(said(block), /codex login/)
    assert.doesNotMatch(said(block), /the (?:thing|program) that (?:actually )?runs an agent/)
  }
  const blocked = codexReadiness({ engine: { known: true, ok: false, code: 'AGENT_CONFINEMENT_UNAVAILABLE' }, codex: { known: true, installed: 'no', signedIn: 'no' } })
  assert.equal(blocked.tone, 'is-warn')
  assert.doesNotMatch(blocked.heading, /optional/)
})

test('setup preserves a current Codex refusal when older presence says installed and signed in', () => {
  const assignment = '    agentReadiness = '
  const start = view.indexOf(assignment + 'reply &&')
  const end = view.indexOf('\n    paint()', start)
  assert.ok(start >= 0 && end > start, 'the real setup reply normalization must be present')
  const normalize = new Function('reply', `return (${view.slice(start + assignment.length, end).trim()})`)
  for (const codexCode of ['AGENT_CODEX_CLI_NOT_INSTALLED', 'AGENT_CONFINEMENT_SIGNED_OUT']) {
    const engine = normalize({ ok: true, code: 'AGENT_ENGINE_READY', readyProvider: 'local', codexCode })
    assert.equal(engine.codexCode, codexCode, 'setup must not discard the default-provider diagnosis')
    const block = codexReadiness({ engine, codex: { known: true, installed: 'yes', signedIn: 'yes' } })
    assert.match(block.heading, /Codex.*optional/i)
    assert.match(said(block), /latest launch check/i)
    assert.match(said(block), /Check again/)
    assert.doesNotMatch(said(block), /so an agent can start/)
  }
})

test('contradictory provider and engine checks cannot claim that an agent can start', () => {
  for (const code of ['AGENT_CODEX_CLI_NOT_INSTALLED', 'AGENT_CONFINEMENT_SIGNED_OUT']) {
    const block = codexReadiness({ engine: { known: true, ok: false, code }, codex: { known: true, installed: 'yes', signedIn: 'yes' } })
    assert.equal(block.tone, 'is-warn')
    assert.match(said(block), /cannot start/)
    assert.doesNotMatch(said(block), /so an agent can start/)
  }
})

test('installation and sign-in instructions follow the configured host platform', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    for (const viaRelay of [false, true]) {
      const absent = said(codexReadiness({ platform, viaRelay,
        codex: { known: true, installed: 'no', signedIn: 'no' } }))
      const signedOut = said(codexReadiness({ platform, viaRelay,
        codex: { known: true, installed: 'yes', signedIn: 'no' } }))
      assert.match(absent, /npm install -g @openai\/codex\b/)
      assert.doesNotMatch(absent, /@openai\/codex@|--version\b/, 'installation must use the current CLI, not a release pin')
      assert.match(signedOut, /codex login/)
      if (platform === 'win32') {
        assert.match(absent, /winget install OpenAI\.Codex\b/)
        assert.match(signedOut, /Windows Terminal/)
      } else {
        assert.doesNotMatch(absent + signedOut, /winget|Windows Terminal/)
        assert.match(absent, /Node\.js and npm installed/)
      }
      if (viaRelay) assert.match(absent, /On that computer/)
    }
  }
})

test('unknown host platforms get labelled alternatives without guessing from the browser', () => {
  const instruction = codexSetupInstructions({ platform: 'unknown', viaRelay: true }).install.join(' ')
  assert.match(instruction, /If that computer runs Windows/)
  assert.match(instruction, /If that computer runs Linux or macOS/)
  assert.match(instruction, /computer you are driving/)
})

test('a sign-in does not prove that an unreadable or pending engine can start', () => {
  for (const engine of [null, { known: false }]) {
    const text = said(codexReadiness({ engine, codex: { known: true, installed: 'yes', signedIn: 'yes' } }))
    assert.match(text, /readiness is still unverified/)
    assert.doesNotMatch(text, /so an agent can start/)
  }
})

test('Linux install and compatibility recovery never sends users to Windows Terminal', () => {
  for (const code of ['AGENT_CODEX_CLI_NOT_INSTALLED', 'AGENT_CONFINEMENT_SIGNED_OUT', 'CODEX_CLI_NOT_FOUND', 'CODEX_VERSION_DETECTION_FAILED', 'CODEX_PROTOCOL_VERSION_MISMATCH']) {
    const text = unavailableReason(code, { platform: 'linux' })
    assert.doesNotMatch(text, /winget|Windows Terminal/)
    assert.match(text, /Codex/)
  }
})

test('the engine saying "something can start" is not Codex saying it is here', () => {
  /* THE EXACT MEASURED STATE: availability ok (a Claude install satisfies it),
     Codex absent and signed out. */
  const block = codexReadiness({
    engine: { known: true, ok: true, code: 'AGENT_ENGINE_READY' },
    codex: { known: true, installed: 'no', signedIn: 'no' },
  })
  assert.doesNotMatch(said(block), CLAIM,
    'the review claims Codex is installed and signed in on a computer that has neither')
  assert.match(said(block), new RegExp(CODEX_SETUP_COMMANDS.install.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'the install command is still unreachable for the person who needs it')
  assert.equal(block.tone, '', 'optional Codex setup is not an overall readiness warning')
    assert.match(block.heading, /Codex.*optional/i)
})

test('installed and signed in is said only when both are proved', () => {
  const ready = codexReadiness({
    engine: { known: true, ok: true, code: 'AGENT_ENGINE_READY' },
    codex: { known: true, installed: 'yes', signedIn: 'yes' },
  })
  assert.match(said(ready), CLAIM)
  assert.equal(ready.tone, '', 'a computer that is ready is not a warning')

  for (const codex of [
    { known: true, installed: 'yes', signedIn: 'no' },
    { known: true, installed: 'yes', signedIn: 'unknown' },
    { known: true, installed: 'unknown', signedIn: 'yes' },
    { known: false },
  ]) {
    const block = codexReadiness({ engine: { known: true, ok: true, code: 'AGENT_ENGINE_READY' }, codex })
    assert.doesNotMatch(said(block), CLAIM,
      `the review claims Codex is ready for presence ${JSON.stringify(codex)}`)
    assert.equal(block.tone, '', 'optional Codex setup is not an overall readiness warning')
    assert.match(block.heading, /Codex.*optional/i)
  }
})

test('signed out is said in the words that fix it', () => {
  const block = codexReadiness({
    engine: { known: true, ok: false, code: 'AGENT_CONFINEMENT_SIGNED_OUT' },
    codex: { known: true, installed: 'yes', signedIn: 'no' },
  })
  /* "Codex is installed" is a fair claim HERE and only here: this module is
     handed a real presence read and this branch requires installed === 'yes'.
     The press-refusal route's copy of this sentence had no probe behind it and
     was measured false on a driven Claude-only machine, so THAT one
     (UNAVAILABLE_TEXT.AGENT_CONFINEMENT_SIGNED_OUT) no longer asserts it. */
  assert.match(said(block), /nobody is signed in to it/)
  assert.match(said(block), new RegExp(CODEX_SETUP_COMMANDS.signIn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('an engine that cannot start anything still speaks, and only for its own reason', () => {
  const dead = codexReadiness({
    engine: { known: true, ok: false, code: 'AGENT_ENGINE_UNAVAILABLE' },
    codex: { known: true, installed: 'yes', signedIn: 'yes' },
  })
  assert.match(said(dead), /An agent cannot start on this computer yet/,
    'a build with no engine reports a ready Codex and nothing about itself')

  /* But the two Codex-shaped codes belong to the provider branches, which say
     the same thing with the command that fixes it. */
  const notInstalled = codexReadiness({
    engine: { known: true, ok: false, code: 'AGENT_CODEX_CLI_NOT_INSTALLED' },
    codex: { known: true, installed: 'no', signedIn: 'no' },
  })
  assert.match(said(notInstalled), /Codex is not installed on this computer/)
  assert.match(said(notInstalled), new RegExp(CODEX_SETUP_COMMANDS.install.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('an unanswered question is neither a tick nor a warning', () => {
  const waiting = codexReadiness({ engine: null, codex: null })
  assert.match(said(waiting), /Checking whether Codex is installed/)
  assert.equal(waiting.tone, '')
  assert.doesNotMatch(said(waiting), CLAIM)
})

test('the review screen asks the per-provider bridge, and does not decide from the engine', () => {
  assert.match(view, /mcProviders\?\.presence/, 'the review no longer asks which programs this computer has')
  const block = view.slice(view.indexOf('function codexReadinessMarkup'), view.indexOf('function codexReadinessMarkup') + 400)
  assert.match(block, /codexReadiness\(\{ engine: agentReadiness, codex: codexPresence \}\)/,
    'the review is deciding its own copy again, which is where the false claim lived')
  assert.ok(!/agentReadiness\.ok === true/.test(view),
    'a Codex sentence is being rendered from the provider-agnostic availability answer again')
})

/* ------------------------------------------------------------------
   THE UNCERTAIN STATE MAY NOT HAND ANYBODY AN INSTALL COMMAND.

   THE REPORT, verbatim, from the owner's own second machine: "i have claude and
   codex downloaded and installed and signed it but when i try to launch agents
   it says nothing was started and to run winget install openAI".

   Two things were wrong and this is the second one. The probe's half -- a
   Windows process reading the PATH it inherited at login and missing everything
   installed since -- is fixed in shell/machine-search-path.cjs and pinned by its
   own suite. This half is the one his report is really about: he was handed an
   install command for a program he had already installed, and after that no
   sentence the product prints about his machine is worth believing.

   'unknown' NOW MEANS "WE COULD NOT FIND IT", WHICH IS NOT "YOU HAVE NOT GOT
   IT". A command printed here is a specific, checkable claim about somebody's
   computer, and this block only has grounds for it in one state.
   ------------------------------------------------------------------ */

/* Every command this module has, so the assertion cannot rot when one is
   renamed or a third is added. */
const EVERY_COMMAND = Object.values(CODEX_SETUP_COMMANDS).filter(value => typeof value === 'string')

test('an uncertain answer is never given an install command', () => {
  for (const codex of [
    { known: true, installed: 'unknown', signedIn: 'unknown' },
    { known: true, installed: 'unknown', signedIn: 'yes' },
    { known: true, installed: 'unknown', signedIn: 'no' },
    { known: false },
  ]) {
    const words = said(codexReadiness({ engine: { known: true, ok: true, code: 'AGENT_ENGINE_READY' }, codex }))
    for (const command of EVERY_COMMAND) {
      assert.ok(!words.includes(command),
        `an install or sign-in command is printed for presence ${JSON.stringify(codex)}: "${words}"`)
    }
    /* And no way round it either: the point is that nothing here tells a person
       to go and install something on a machine we could not read. */
    assert.doesNotMatch(words, /\binstall\b/i, `the word "install" survives for presence ${JSON.stringify(codex)}`)
    assert.doesNotMatch(words, /\bwinget\b|\bnpm\b/i, `a package manager is named for presence ${JSON.stringify(codex)}`)
  }
})

test('an uncertain answer says what is true instead: could not find it, may still be here, and what to do', () => {
  const words = said(codexReadiness({
    engine: { known: true, ok: true, code: 'AGENT_ENGINE_READY' },
    codex: { known: true, installed: 'unknown', signedIn: 'unknown' },
  }))
  assert.match(words, /could not find/i, 'it does not say the one thing that is actually known')
  assert.match(words, /not the same as it not being here/i, 'it lets "we could not find it" stand as "you have not got it"')
  assert.match(words, /close ToolsEnabled and open it again/i, 'it leaves the person with nothing to do')
  /* No blame anywhere in it. A person whose machine is set up correctly must
     not read a sentence implying they got something wrong. */
  assert.doesNotMatch(words, /\byou (did not|have not|haven't|didn't)\b/i, `the copy blames the reader: "${words}"`)
})

test('a proven absence still gets the command, because that person needs it', () => {
  /* The other half of the same rule. 'no' now means the search genuinely
     finished and found nothing, and a stranger with a bare computer is exactly
     who this screen was written for. Withholding it from them to protect the
     uncertain case would trade one broken first hour for another. */
  const words = said(codexReadiness({
    engine: { known: true, ok: true, code: 'AGENT_ENGINE_READY' },
    codex: { known: true, installed: 'no', signedIn: 'no' },
  }))
  assert.ok(words.includes(CODEX_SETUP_COMMANDS.install))
})

test('a relay reader is told which computer the facts and remedies belong to', () => {
  const engine = { known: true, ok: true, code: 'AGENT_ENGINE_READY' }
  const cases = [
    null,
    { known: false },
    { known: true, installed: 'unknown', signedIn: 'unknown' },
    { known: true, installed: 'no', signedIn: 'no' },
    { known: true, installed: 'yes', signedIn: 'no' },
    { known: true, installed: 'yes', signedIn: 'unknown' },
    { known: true, installed: 'yes', signedIn: 'yes' },
  ]

  for (const codex of cases) {
    const words = said(codexReadiness({ engine, codex, viaRelay: true }))
    assert.doesNotMatch(words, /\b(on|ask|somewhere) this computer\b|\bthis window opened\b/,
      `relay copy points at the browser reader's machine for presence ${JSON.stringify(codex)}: "${words}"`)
  }

  const absent = said(codexReadiness({ engine, codex: cases[3], viaRelay: true, platform: 'win32' }))
  assert.match(absent, /On that computer, open Windows Terminal/)
  assert.doesNotMatch(absent, /(?:^|\s)Open Windows Terminal/,
    'the relay reader is told to run the install on the browser machine')

  const engineFailure = said(codexReadiness({
    engine: { known: true, ok: false, code: 'AGENT_ENGINE_UNAVAILABLE' },
    codex: cases[6],
    viaRelay: true,
  }))
  assert.match(engineFailure, /computer you are driving/)
  assert.doesNotMatch(engineFailure, /this computer|Open Windows Terminal|close ToolsEnabled/i)
})

/* ------------------------------------------------------------------
   A MODEL ON THIS COMPUTER'S OWN HARDWARE -- localModelReadiness(), the
   review's fourth card, built alongside PROVIDER_SETUP's local row and
   src/views/guide.js's local-model panel (B-pool-3, local models).

   THE TONE ASYMMETRY IS THE PROPERTY WORTH A TEST. codexReadiness() marks a
   missing Codex `is-warn`, because nothing else in setup guarantees an agent
   can start without SOME engine. Nothing in setup depends on a local runtime
   the same way -- it is a first-class peer to the paid providers (owner
   ruling, "the free path is the product, not a consolation") but never
   required (owner ruling, "enable depth, don't require it") -- so its
   absence must read as plain information, never a warning demanding
   attention. Only the genuinely uncertain state ("could not check") keeps
   the warn tone, matching the vocabulary the rest of this screen already
   uses for uncertainty.
   ------------------------------------------------------------------ */

test('an unasked local-model question is neither a tick nor a warning', () => {
  const waiting = localModelReadiness({ local: null })
  assert.match(said(waiting), /Checking whether a local model runtime is running/)
  assert.equal(waiting.tone, '')
})

test('a local runtime with nothing listening is plain information, never a warning', () => {
  const notReady = localModelReadiness({ local: { known: true, ready: false, selected: null } })
  assert.equal(notReady.tone, '', 'an optional capability being unset must not read as something left undone')
  assert.match(said(notReady), /entirely optional/)
  /* IT NAMES WHERE THE INSTALL LIVES, and that place is a section of Settings
     now rather than a page of its own. What the sentence owes the reader is
     unchanged: an optional thing they did not do, and the one place that can do
     it for them if they ever want it. */
  assert.match(said(notReady), /Settings, under "This computer"/)
})

test('a ready local runtime is stated plainly and names the runtime that answered', () => {
  const ready = localModelReadiness({
    local: { known: true, ready: true, selected: { runtime: 'ollama', displayName: 'Ollama' } },
  })
  assert.equal(ready.tone, '')
  assert.match(said(ready), /Ollama is already running/)
  assert.match(said(ready), /Launch controls and Team panels/)
})

test('a ready runtime with no displayName still says something, never crashing on a bare answer', () => {
  const ready = localModelReadiness({ local: { known: true, ready: true, selected: {} } })
  assert.equal(ready.tone, '')
  assert.match(said(ready), /A runtime is already running/)
})

test('an unreadable local-model answer IS a warning, unlike a plain absence', () => {
  const unknown = localModelReadiness({ local: { known: false } })
  assert.equal(unknown.tone, 'is-warn')
  assert.match(said(unknown), /could not ask/)
  /* And it must not be confused with the ready-but-optional sentence, which
     shares no words with it -- a regression that collapsed the two states to
     one message would still pass a looser "some warning-shaped text"
     assertion, so this checks the actual, different words each one owns. */
  assert.doesNotMatch(said(unknown), /entirely optional/)
})

test('the relay reader is told which computer the local-model facts belong to', () => {
  const notReady = said(localModelReadiness({ local: { known: true, ready: false, selected: null }, viaRelay: true }))
  assert.match(notReady, /computer you are driving/)
  assert.doesNotMatch(notReady, /\bthis computer\b/)

  const ready = said(localModelReadiness({
    local: { known: true, ready: true, selected: { displayName: 'Ollama' } },
    viaRelay: true,
  }))
  assert.match(ready, /computer you are driving/)
  assert.doesNotMatch(ready, /\bthis computer\b/)
})

test('the review screen wires the local-model card the same way it wires the Codex one', () => {
  assert.match(view, /mcProviders\?\.detectLocal/, 'the review no longer asks whether a local runtime is running')
  const block = view.slice(view.indexOf('function localModelReadinessMarkup'), view.indexOf('function localModelReadinessMarkup') + 400)
  assert.match(block, /localModelReadiness\(\{ local: localModelPresence \}\)/,
    'the review is deciding its own local-model copy again, the exact defect this file exists to prevent')
  assert.match(view, /data-setup-details="optional-tools"[\s\S]*?\$\{localModelReadinessMarkup\(\)\}/,
    'the local-model card must remain reachable in the optional tools disclosure')
})

test('setup never installs or downloads anything for local models -- that stays read-only, like the Codex card', () => {
  /* THE SAME "READ ONLY" PROPERTY setup.js's own comment states for
     codexReadinessMarkup(), now measured for its sibling: no install/pull
     verb may be called from this file, because the actual controls live on
     guide.js's PROVIDER_SETUP (owner ruling via fleet-B) and a second,
     thinner copy of them here would be the exact "two paths for one thing"
     defect this codebase has already fixed once. */
  const setupSection = view.slice(view.indexOf('function loadLocalModelPresence'), view.indexOf('function loadLocalModelPresence') + 800)
  for (const forbidden of ['installRuntime', 'pullLocalModel', 'installStart']) {
    assert.ok(!setupSection.includes(forbidden), `setup.js's local-model read now calls ${forbidden}(), which installs or downloads something`)
  }
  assert.match(setupSection, /detectLocal/, 'this test\'s premise: the section it is reading is the local-model load function')
})
