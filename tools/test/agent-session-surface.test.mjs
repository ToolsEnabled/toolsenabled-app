import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { canonicalRootForTests } from '../canonical-root.mjs'

import { AVAILABILITY_CODES, START_REFUSAL_CODES, createAgentHost, engineAvailability, engineCandidates } from '../../shell/agent-host.cjs'
import { RECORD_AVAILABILITY_CODES, createSpawnRecorder } from '../../shell/spawn-record.cjs'
import { sessionEventText, sessionTurnStatus } from '../../src/agent-session-events.js'
import {
  AVAILABILITY_SUBJECT_REMOTE,
  MISSING_MODULE,
  UNAVAILABLE_TEXT,
  refusalCode,
  unavailableReason,
} from '../../src/agent-availability-copy.js'
import { confinementNote } from '../../src/agent-confinement-copy.js'
import { ENGINE_REASON, readAgentEngine } from '../../src/local-activity.js'
import { readerRemedy, refusalSentence } from '../../src/refusal-copy.js'
/* The compose panel's own composer, because the defect this file now also
   covers is not "the code has no copy" but "the code reaches THAT surface as
   the sentence for a refusal nobody explained". Only startRefusalSentence()
   can answer that. */
import { PALETTE_PANEL, START_REFUSAL, pasteRefusalSentence, startRefusalSentence } from '../../src/fleet-tree-copy.js'
import { testScratchRoot } from '../lib/test-scratch-root.mjs'

/* THIS SUITE IS NOT ABOUT THE MEMORY ADMISSION RULE. Left unset, createAgentHost
   defaults freeMemory to the real os.freemem() (shell/agent-host.cjs:2559), which
   startSession consults at :3870 and refuses at :3873. Every start below would then
   fail with AGENT_MEMORY_LOW whenever this computer happens to be short of memory,
   so the suite's colour would track the machine rather than the code under test.
   memoryAdmission() keeps its own coverage in agent-memory-admission.test.mjs, and
   agent-resource-wiring.test.mjs drives it deliberately with freeMemory: () => 0. */
const TEST_FREE_MEMORY = () => 64 * 1024 * 1024 * 1024

// The interface can start an agent only if three things hold at once: the
// renderer can reach the agent channels, the surface can tell whether an
// engine exists BEFORE it offers a control, and nothing on that path can put
// a filesystem path on screen. Each test below pins exactly one of those.

const ROOT = resolve(import.meta.dirname, '..', '..')
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8')
/* The confinement/planner source ships in the SELECTED Engine, not this app
   checkout's unbuilt staged capability/ layer. Resolve it strictly: a missing
   or unconfigured Engine root REFUSES here (canonicalRootForTests
   requireConfigured), never reading an absent capability/ path and never a
   staged fallback. */
const engineFile = (rel) => readFileSync(join(canonicalRootForTests({ requireConfigured: true }), rel), 'utf8')
const TEST_SCRATCH_ROOT = testScratchRoot('.toolsenabled-agent-surface-test')
mkdirSync(TEST_SCRATCH_ROOT, { recursive: true })

/* Account-fence tests must not stage an engine under whichever profile invoked
   Node. Keeping their disposable trees below this checkout makes them belong
   to the same installation profile as shell/agent-host.cjs. */
const testScratch = prefix => mkdtempSync(join(TEST_SCRATCH_ROOT, prefix))

/* Availability now verifies that the engine's CLI is executable before it
   reports ready. Keep that machine prerequisite controlled just like the
   engine and credential fixtures below: whether the developer running this
   test has installed Codex is not part of the host contract under test. */
const CLI_BIN = testScratch('mc-agent-cli-')
const CODEX_CLI = join(CLI_BIN, process.platform === 'win32' ? 'codex.cmd' : 'codex')
writeFileSync(CODEX_CLI, process.platform === 'win32' ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n')
if (process.platform !== 'win32') chmodSync(CODEX_CLI, 0o755)
const PREVIOUS_PATH = process.env.PATH
process.env.PATH = `${CLI_BIN}${process.platform === 'win32' ? ';' : ':'}${PREVIOUS_PATH || ''}`
test.after(() => {
  if (PREVIOUS_PATH === undefined) delete process.env.PATH
  else process.env.PATH = PREVIOUS_PATH
  rmSync(CLI_BIN, { recursive: true, force: true })
  rmSync(TEST_SCRATCH_ROOT, { recursive: true, force: true })
})

/* WHERE THE HANDLER BODIES LIVE NOW. The command-surface extraction moved the
   bodies of every mc-agent:* / mc-org:* handler out of shell/main.cjs into
   shell/agent-command-surface.cjs (one shared surface, so the IPC path and the
   relay facade the design names cannot drift). main.cjs keeps the Electron
   frame check and a thin wrapper per channel. Pins about the BODY below read
   the surface; pins about the BOUNDARY still read main.cjs. */
const surfaceBody = (command) => {
  const source = read('shell/agent-command-surface.cjs')
  const start = source.indexOf(`'${command}': async`)
  assert.ok(start >= 0, `shell/agent-command-surface.cjs has no body for ${command}`)
  const next = source.slice(start + 1).search(/\n    '(agent|org):[a-z-]+': async/)
  return next === -1 ? source.slice(start) : source.slice(start, start + 1 + next)
}

test('availability reports a bounded code and never a path', () => {
  // The engine-less answer must stay {ok, code}: the resolver's real message
  // lists every path it tried, and rendering that is how a private checkout
  // path reached the DOM before.
  //
  // `capabilityRoot: null` pins that state explicitly. Deleting the env var
  // used to be sufficient, because an unconfigured shell had no other way to
  // find an engine -- but a shipped payload now legitimately resolves one, so
  // "no environment variable" no longer means "no engine". Without this the
  // test measures whether a payload happens to be staged in the checkout
  // beside it, and flips green/red on ambient state rather than on the
  // behaviour it is pinning.
  const previous = process.env.MISSION_CONTROL_ENGINE
  delete process.env.MISSION_CONTROL_ENGINE
  try {
    const result = engineAvailability({ capabilityRoot: null })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'AGENT_ENGINE_UNAVAILABLE')
    assert.deepEqual(Object.keys(result).sort(), ['code', 'ok'])
    for (const value of Object.values(result)) {
      assert.doesNotMatch(String(value), /[\\/]/, 'no availability field may contain a path separator')
    }
  } finally {
    if (previous === undefined) delete process.env.MISSION_CONTROL_ENGINE
    else process.env.MISSION_CONTROL_ENGINE = previous
  }
})

/* A complete engine tree: all three hostModules present, laid out exactly as
   the payload lays them out. Pointing at the ENGINE DIRECTORY inside it rather
   than at the tree root is deliberate -- normalizedModulePath() appends
   codex-process.js to any path not ending in .js, and engineRootOf() then walks
   three levels back up, so this is the only shape from which the host resolves
   the sibling modules the way it does on a real install. */
const COMPLETE_ENGINE = resolve(ROOT, 'tools/test/fixtures/confined-engine/src/lib/agent-engine')

/* Payload-relative paths, duplicated from shell/agent-host.cjs on purpose: a
   test that imported the constants could not notice one of them being changed
   to something the installer does not stage. */
const HOST_MODULES = Object.freeze({
  engine: 'src/lib/agent-engine/codex-process.js',
  confinement: 'src/lib/agent-session-confinement.js',
  launchEnvironment: 'src/lib/providers/subscription-launch-env.js',
})

/* Build a payload root that carries exactly the named modules, copied from the
   complete fixture tree. `omit` is what makes the negative direction real:
   every "not ready" assertion below is about a tree that is genuinely missing a
   file, not about a stub that returns a code. */
function stagePayload({ omit = [] } = {}) {
  const root = testScratch('mc-capability-')
  const source = resolve(ROOT, 'tools/test/fixtures/confined-engine')
  for (const [name, relative] of Object.entries(HOST_MODULES)) {
    if (omit.includes(name)) continue
    const target = join(root, ...relative.split('/'))
    mkdirSync(join(target, '..'), { recursive: true })
    copyFileSync(join(source, ...relative.split('/')), target)
  }
  return root
}

function withoutEngineEnvironment(run) {
  const previous = process.env.MISSION_CONTROL_ENGINE
  delete process.env.MISSION_CONTROL_ENGINE
  try {
    return run()
  } finally {
    if (previous === undefined) delete process.env.MISSION_CONTROL_ENGINE
    else process.env.MISSION_CONTROL_ENGINE = previous
  }
}

test('availability resolves a real configured engine', () => {
  // Proves the probe answers ok for an engine that genuinely exports the
  // contract, rather than only ever failing closed. THE CONVERSE DIRECTION,
  // and the one that matters most for a readiness check that got stricter: a
  // false negative here does not annoy a customer, it deletes the product's
  // core feature.
  const result = engineAvailability({ enginePath: COMPLETE_ENGINE })
  assert.equal(result.ok, true, 'a complete engine tree must report ready')
  assert.equal(result.code, 'AGENT_ENGINE_READY')
})

/* Derive the preload from main.cjs rather than naming one. An earlier version
   of this suite asserted against shell/preload.cjs, which no window loads --
   it went green while window.mcAgent was undefined in the running app. A test
   that names the wrong file is the same defect as a control that cannot work:
   both report success for something that does not exist. */
export function activePreloadPath() {
  const main = read('shell/main.cjs')
  const match = main.match(/preload:\s*path\.join\(__dirname,\s*'([^']+)'\)/)
  assert.ok(match, 'main.cjs must declare its preload via path.join(__dirname, ...)')
  return `shell/${match[1]}`
}

test('the loaded preload is the one the tests check', () => {
  const active = activePreloadPath()
  assert.equal(active, 'shell/fleet-profile-preload.cjs')
  assert.doesNotMatch(
    read('shell/preload.cjs'),
    /exposeInMainWorld\('mcAgent'/,
    'the unloaded preload must not carry an agent bridge that no window can reach',
  )
})

test('the renderer has a bounded, deliberate bridge to the agent channels', () => {
  // The inverse of the old gate. The exposure is required now -- without it
  // no agent can be started from the interface at all -- but it stays a
  // fixed, named surface, and ipcRenderer itself is never handed over.
  const preload = read(activePreloadPath())
  assert.match(preload, /exposeInMainWorld\('mcAgent'/, 'preload must expose the agent bridge')
  for (const call of ['availability', 'start', 'send', 'interrupt', 'close', 'onEvent']) {
    assert.match(preload, new RegExp(`\\b${call}:`), `preload must expose ${call}`)
  }
  assert.doesNotMatch(
    preload,
    /exposeInMainWorld\([^)]*ipcRenderer\s*\)/,
    'preload must never hand ipcRenderer itself to the renderer',
  )
})

test('the engine resolver carries no hardcoded sibling-repo default', () => {
  // Unchanged from the original gate: this clause of BLOCKER 2 is permanent.
  const agentHost = read('shell/agent-host.cjs')
  assert.doesNotMatch(agentHost, /sibling default/, 'the resolver must not carry a filesystem-guess candidate')
  assert.match(agentHost, /MISSION_CONTROL_ENGINE/, 'the engine path must come from configuration')
})

test('the spawn surface no longer claims that no tier restricts a running session', () => {
  // THIS TEST USED TO ASSERT THE OPPOSITE, and that is the point of rewriting it
  // rather than deleting it. It required the sentence "No permission tier limits
  // a running session" to be PRESENT, because when it was written the tier was
  // recorded and enforced against nothing (T5, unbuilt) and a control that
  // implied a limit would have been claiming safety the product did not have.
  //
  // T5 was then built. capability/src/lib/agent-session-confinement.js resolves
  // the recorded level into thread options and shell/agent-host.cjs startSession()
  // passes them to the engine, so the sentence became false -- and this gate went
  // on requiring it. A test that pins a claim rather than the reason for the claim
  // becomes a gate protecting the defect, which is exactly what happened here.
  //
  // So it now asserts the property the original was reaching for: the control
  // must not overstate the product's blast radius in EITHER direction.
  const surface = read('src/agent-session.js')
  assert.doesNotMatch(
    surface.replace(/\/\*[\s\S]*?\*\//g, ''),
    /No permission tier limits a running session/,
    'the retired claim must not be reachable from the shipped code path',
  )
  assert.match(surface, /confinementNote\(/, 'the sentences must be computed from a reading of this install')
  assert.match(surface, /bridge\.confinement/, 'the reading must come from the shell, not from a constant')
})

test('the spawn surface states that starts are recorded, and claims no more', () => {
  // The claim must be exactly as strong as the evidence. "Recorded on this
  // device" is true: an app-local signed chain, written before the spawn.
  // Calling it the audit ledger, or implying off-device attestation, would
  // overstate a key that lives on the same machine as the records.
  //
  // Asserted against the SENTENCE the copy module produces rather than against a
  // source constant. The constant this used to slice out of src/agent-session.js
  // no longer exists, and the previous form -- a regex match indexed at [0] --
  // threw a TypeError rather than failing with a message when it stopped
  // matching, which is a test that cannot tell you what broke.
  const sentences = confinementNote({
    ok: true, tier: 'unrestricted', sandbox: 'danger-full-access', failedClosed: false,
  }).sentences.join(' ')
  assert.match(sentences, /recorded on this device before it runs/)
  assert.doesNotMatch(
    sentences,
    /audit ledger|canonical|tamper-proof|verified by/i,
    'the note must not claim more than an app-local signed record',
  )
})

test('a spawn is refused when it cannot be recorded', () => {
  // The whole point of the gate: no receipt, no process. The record call must
  // come before any spawn, and a failure must refuse rather than continue.
  const main = read('shell/main.cjs')
  /* Re-pointed at the surface's start body after the command-surface extraction; the ordering fact is unchanged. */
  const start = surfaceBody('agent:start')
  /* `await`ed since the canonical half moved onto the ledger's own thread
     (shell/canonical-audit.cjs): the gate is unchanged -- the start still waits
     for the record and a refusal still throws before anything is spawned -- so
     this pins the record AND the wait, not the thread it happens on. */
  assert.match(start, /record = await recordSpawnIntent\(request\)/, 'the spawn must be recorded first, and waited for')
  assert.ok(
    start.indexOf('recordSpawnIntent(request)') < start.indexOf('startSession(request)'),
    'the record must be written before the session is started, not after',
  )
  /* recordSpawnIntent() itself -- the gate that refuses -- is still main.cjs's own. */
  assert.match(
    main,
    /agentIpcError\(\s*'MC_AGENT_RECORD_UNAVAILABLE'/,
    'a record failure must refuse the spawn with a typed error',
  )
})

test('availability requires an engine, a usable recorder, and the workspace the session runs in', () => {
  // Reporting only some of what a start needs would let the surface offer a
  // Start control that the start handler then refuses -- a dead button by a
  // different route.
  //
  // Bounded by the handler's own closing brace rather than by a character
  // count. The earlier version sliced the first 600 characters, which made the
  // test's meaning depend on how long the comments inside the handler happened
  // to be -- it went red for a comment and would have gone green for a handler
  // that lost a check under a shorter one.
  const main = read('shell/main.cjs')
  const start = main.indexOf("ipcMain.handle('mc-agent:availability'")
  assert.ok(start > 0, 'main.cjs must register the availability channel')
  assert.match(main.slice(start, main.indexOf('\n})', start)), /run\('agent:availability'/, 'and dispatch it to the shared surface')
  /* Re-pointed at the surface's availability body after the command-surface extraction; the probe facts are unchanged. */
  const handler = surfaceBody('agent:availability')
  assert.match(handler, /engineAvailability\(\{[^)]*defaultCwd:/, 'the probe must be asked about the working directory the session will use')
  assert.match(handler, /spawnRecordAvailability\(\)/)

  /* THE SAME ORDER THE PRESS REFUSES IN. mc-agent:start records the intent
     before it asks the host for a session, so an installation with both faults
     is refused by the recorder. A probe that named the engine first would send
     that person to fix the wrong thing. */
  // Comments stripped first: this handler EXPLAINS the order in prose above
  // the code that implements it, and an index test over the raw text measures
  // the sentence rather than the statement.
  const executable = handler.replace(/\/\*[\s\S]*?\*\//g, '')
  assert.ok(
    executable.indexOf('spawnRecordAvailability()') < executable.indexOf('engineAvailability('),
    'availability must ask about the record before the engine, because the start does',
  )
  /* The start body is the surface's too, after the command-surface extraction. */
  const startHandler = surfaceBody('agent:start')
  assert.ok(
    startHandler.indexOf('recordSpawnIntent(request)') < startHandler.indexOf('getAgentHost()'),
    'this test\'s premise: the start really does record before it resolves a host',
  )

  // ONE preparation, called by both, so the probe cannot validate a directory
  // the start would only create afterwards -- which on a fresh install would
  // report a broken workspace that is about to exist.
  assert.match(handler, /ensureWorkspaceRoot\(\)/, 'the probe must prepare the workspace the same way the start does')
  const hostBuildStart = main.indexOf('async function buildAgentHost()')
  const hostBuildEnd = main.indexOf('\n}\n', hostBuildStart)
  assert.ok(hostBuildStart > 0 && hostBuildEnd > hostBuildStart,
    'the single-flight host build must remain a bounded top-level function')
  const hostBuild = main.slice(hostBuildStart, hostBuildEnd)
  assert.match(hostBuild, /ensureWorkspaceRoot\(\)/, 'the single-flight host build must use the same preparation the probe uses')
  assert.match(main, /const buildAgentHostOnce = asyncSingleFlight\(buildAgentHost\)/,
    'every getAgentHost caller must share that one prepared build while readiness is pending')
  assert.equal(
    (main.match(/fs\.mkdirSync\(WORKSPACE_ROOT/g) || []).length,
    1,
    'the workspace must be created in exactly one place, or the probe and the start can disagree about it',
  )
})

test('the surface renders only recognised event text', () => {
  const id = 'session-a'
  assert.equal(sessionEventText({ sessionId: id, event: { type: 'assistant_text_delta', text: 'hi' } }, id), 'hi')
  // A different session's packet must never reach this surface's transcript.
  assert.equal(sessionEventText({ sessionId: 'other', event: { type: 'assistant_text_delta', text: 'leak' } }, id), null)
  // An unrecognised event is ignored rather than rendered.
  assert.equal(sessionEventText({ sessionId: id, event: { type: 'tool_call', text: 'x' } }, id), null)
  assert.equal(sessionEventText(null, id), null)
  assert.equal(sessionTurnStatus({ sessionId: id, event: { type: 'turn_completed', status: 'completed' } }, id), 'completed')
  assert.equal(sessionTurnStatus({ sessionId: 'other', event: { type: 'turn_completed', status: 'x' } }, id), null)
})

/* THE COMPOSER IS THE SECOND READER OF THAT SAME STREAM, and a second reader is
 * how one of the two comes to be wrong in private.
 *
 * The agent page's chat box was wired to a live session and then read the
 * packets itself: `packet.text`, falling back to `packet.delta.text`. Neither
 * field exists on anything this product emits -- the test above is the shape --
 * so the condition was false for every packet and the composer rendered NOTHING
 * back from a real, running agent. The suite above could not see it: the readers
 * were correct and untouched; the surface that mattered simply did not use them.
 *
 * The second clause is the same defect from the other end. A refusal on this
 * channel arrives as a REJECTED invoke whose message shell/main.cjs has
 * deliberately replaced with the bare code, so `catch (error) { show(
 * error.message) }` prints a machine identifier to a person -- the thing
 * tools/test/refusal-copy.test.mjs exists to prevent, by the one route its scan
 * cannot see (it looks for a code in a template, and this was an Error's own
 * message). The sentence has to come from the copy tables, through `fail`.
 *
 * PINNED AS SOURCE because the listener and the catch are closures inside a view
 * builder that no unit test can reach; comment lines are dropped first, since
 * both notes above quote the very expressions being forbidden. */
test('the agent page composer reads the live stream through the shared readers, and prints no Error text', () => {
  const withoutNotes = (text) => text
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join('\n')

  const view = withoutNotes(read('src/views/agent.js'))
  assert.match(
    view,
    /import \{[^}]*\bcreateSessionTextReader\b[^}]*\bsessionTurnStatus\b[^}]*\} from '\.\.\/agent-session-events\.js'/,
    'the agent page must read live packets through agent-session-events.js, not a shape of its own',
  )
  assert.equal(
    view.match(/\bpacket\s*\.\s*(text|delta)\b/g),
    null,
    'the composer must not reach into a packet directly -- that reading was false for every packet this product emits',
  )

  const chat = withoutNotes(read('src/components.js'))
  assert.equal(
    chat.match(/\b(error|err|reason)\s*(?:\?\.|\.)\s*message\b/g),
    null,
    "the chat window must not put an Error's own message on screen: on this channel that message is the machine code",
  )
})

test('every agent channel validates its sender frame', () => {
  // These channels create and drive a real CLI child process. The shell has no
  // will-navigate or window-open guard, so the sender check is the boundary
  // that actually holds: without it, any frame reaching the preload could
  // spawn. The sibling fleet-profile handlers already did this; the spawn
  // channels did not, which was the wrong way round.
  const main = read('shell/main.cjs')
  const channels = ['availability', 'start', 'send', 'interrupt', 'close']
  for (const channel of channels) {
    assert.match(
      main,
      new RegExp(`ipcMain\\.handle\\('mc-agent:${channel}'[^\\n]*\\n\\s*assertTrustedAgentSender\\(event\\)`),
      `mc-agent:${channel} must validate its sender frame as its very first statement`,
    )
  }
  assert.match(
    main,
    /function assertTrustedAgentSender[\s\S]{0,300}trustedFleetProfileSender/,
    'the agent sender check must reuse the shell trusted-sender test, not define a second one',
  )
})

test('the agent page mounts the session surface and closes it on destroy', () => {
  const view = read('src/views/agent.js')
  assert.match(view, /mountAgentSessionSurface\(root/, 'the agent page must mount the session surface')
  assert.match(view, /destroyAgentSession\(\)/, 'navigating away must close any open session')
})

test('availability resolves the engine the installer ships, with no environment variable set', () => {
  // THE CUSTOMER PATH, and the one that was dead on every shipped copy until
  // 2026-08-10. Measured over CDP against the real installed 1.0.5:
  // mc.write.agent-session was already "enabled" and availability() still
  // answered AGENT_ENGINE_UNAVAILABLE, because engineCandidates() knew only an
  // explicit enginePath and MISSION_CONTROL_ENGINE. A customer has neither, and
  // no UI sets one, so "start an agent from inside ToolsEnabled" could never
  // work. The engine now ships in the capability payload
  // (tools/capability-manifest.json hostModules) and resolves from the same
  // root shell/setup-record.cjs already uses.
  //
  // The fixture mirrors the payload's real layout rather than working around
  // the resolver, so a change to PAYLOAD_ENGINE_MODULE breaks this test.
  const root = stagePayload()
  try {
    withoutEngineEnvironment(() => {
      const result = engineAvailability({ capabilityRoot: root })
      assert.equal(result.ok, true, 'a payload that carries every host module must resolve without any environment variable')
      assert.equal(result.code, 'AGENT_ENGINE_READY')
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------
   READINESS MEANS STARTABLE.

   The defect these pin: engineAvailability() resolved the ENGINE and answered
   AGENT_ENGINE_READY, while startSession() additionally required the
   confinement planner, the launch-environment scrub, and a working directory
   the OS will accept. Readiness and startability were computed from two
   different sources, so on any payload missing one of the other modules the
   product reported READY, enabled Start, and threw on every press.

   Not hypothetical. agent-session-confinement.js and subscription-launch-env.js
   were declared under `hostModules` AFTER the 1.0.5 installer was built, so the
   copy already delivered to the second machine is exactly that payload.
   ------------------------------------------------------------------ */

test('a payload with the engine but no confinement planner is not ready', () => {
  const root = stagePayload({ omit: ['confinement'] })
  try {
    withoutEngineEnvironment(() => {
      const result = engineAvailability({ capabilityRoot: root })
      assert.equal(result.ok, false, 'an engine alone is not a startable installation')
      assert.equal(result.code, 'AGENT_CONFINEMENT_UNAVAILABLE', 'the refusal must name the missing precondition, not a generic engine fault')
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a payload with no launch-environment scrub is not ready', () => {
  const root = stagePayload({ omit: ['launchEnvironment'] })
  try {
    withoutEngineEnvironment(() => {
      const result = engineAvailability({ capabilityRoot: root })
      assert.equal(result.ok, false, 'a copy that cannot protect the billed account is not startable')
      assert.equal(result.code, 'AGENT_LAUNCH_ENVIRONMENT_UNAVAILABLE', 'the refusal must name the launch-environment module')
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a payload missing two host modules reports the one the start would report', () => {
  // ORDER, not merely membership. A probe that named a different one of two
  // true faults would send someone to fix the wrong thing, and the start path
  // resolves confinement before the launch environment.
  const root = stagePayload({ omit: ['confinement', 'launchEnvironment'] })
  try {
    withoutEngineEnvironment(() => {
      assert.equal(
        engineAvailability({ capabilityRoot: root }).code,
        'AGENT_CONFINEMENT_UNAVAILABLE',
        'the probe must resolve preconditions in the start path order',
      )
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------
   THE FIFTH PRECONDITION, found by another lane measuring the shipped build.

   Same packaged binary, same isolated user-data directory, one variable:
     USERPROFILE with no Codex sign-in -> availability READY, start() REFUSED
     USERPROFILE with a Codex sign-in  -> availability READY, start() STARTED
   The refusal was correct -- a confined level builds its session from the
   user's auth.json -- but the probe could not see it, so the product offered an
   enabled button that refused every press.
   ------------------------------------------------------------------ */

function withInstallationProfile(profileRoot, run) {
  const previous = process.env.CODEX_HOME
  const previousProfile = process.env.MC_TEST_INSTALLATION_PROFILE_ROOT
  const previousResolved = process.env.MC_TEST_CONFINEMENT_RESOLVED
  /* A poisoned ambient override proves the probe uses the profile owned by the
     installed planner, not the account that happened to launch this test. */
  process.env.CODEX_HOME = join(profileRoot, 'ambient-codex-home-must-not-be-used')
  process.env.MC_TEST_INSTALLATION_PROFILE_ROOT = profileRoot
  try {
    return run()
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previous
    if (previousProfile === undefined) delete process.env.MC_TEST_INSTALLATION_PROFILE_ROOT
    else process.env.MC_TEST_INSTALLATION_PROFILE_ROOT = previousProfile
    if (previousResolved === undefined) delete process.env.MC_TEST_CONFINEMENT_RESOLVED
    else process.env.MC_TEST_CONFINEMENT_RESOLVED = previousResolved
  }
}

test('overall readiness recognizes each supported alternative without inventing Codex sign-in', () => {
  for (const provider of ['local', 'claude', 'gemini', 'grok', 'antigravity']) {
    const root = stagePayload()
    const modules = {
      local: ['local-node-process.js', 'startLocalSession'],
      claude: ['claude-cli-process.js', 'startClaudeSession'],
      gemini: ['acp-process.js', 'startAcpSession', 'resumeAcpSession'],
      grok: ['acp-process.js', 'startAcpSession', 'resumeAcpSession'],
      antigravity: ['antigravity-cli-process.js', 'startAntigravitySession', 'resumeAntigravitySession'],
    }
    const [file, ...exports] = modules[provider]
    writeFileSync(join(root, 'src/lib/agent-engine', file),
      `module.exports = { ROOT_ADMISSION_CONTRACT_VERSION: 1, MODEL_SELECTION_CONTRACT_VERSION: 1, ${exports.map(name => `${name}() { throw new Error('readiness must never start a provider') }`).join(',')} }`)
    const planner = join(root, HOST_MODULES.confinement)
    writeFileSync(planner, readFileSync(planner, 'utf8') + '\nmodule.exports.localSessionPlan = module.exports.acpSessionPlan = module.exports.antigravitySessionPlan = () => { throw new Error("readiness must not prepare a session") };\n')
    try {
      withInstallationProfile(root, () => {
        process.env.MC_TEST_CONFINEMENT_RESOLVED = JSON.stringify({ tier: 'guided', isolated: true })
        const result = engineAvailability({ enginePath: join(root, HOST_MODULES.engine),
          localRuntime: provider === 'local' ? { ok: true, ready: true } : null,
          providerPresence: () => ({ ok: true, providers: [{ id: provider, installed: 'yes', signedIn: 'unknown' }],
            clients: provider === 'antigravity' ? [{ client: 'antigravity', provider: 'gemini', installed: 'yes' }] : [] }),
        })
        assert.equal(result.ok, true, provider)
        assert.equal(result.readyProvider, provider)
        assert.equal(result.codexCode, 'AGENT_CONFINEMENT_SIGNED_OUT')
      })
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
})

test('local runtime evidence cannot bypass missing payload, planner, account, or launch dependencies', () => {
  for (const fault of ['runtime-unknown', 'runtime-negative', 'local-payload', 'local-planner', 'confinement', 'launchEnvironment', 'account']) {
    const root = stagePayload({ omit: [fault] })
    if (fault !== 'local-payload') writeFileSync(join(root, 'src/lib/agent-engine/local-node-process.js'), 'exports.startLocalSession = () => { throw Error("must not start") }')
    if (fault !== 'confinement' && fault !== 'local-planner') {
      const planner = join(root, HOST_MODULES.confinement)
      writeFileSync(planner, readFileSync(planner, 'utf8') + '\nmodule.exports.localSessionPlan = () => { throw Error("must not prepare") };\n')
    }
    if (fault === 'account') mkdirSync(join(root, 'foreign-profile-sentinel'))
    try {
      withInstallationProfile(root, () => {
        process.env.MC_TEST_CONFINEMENT_RESOLVED = JSON.stringify({ tier: 'guided', isolated: true })
        const result = engineAvailability({ enginePath: join(root, HOST_MODULES.engine),
          defaultCwd: fault === 'account' ? join(root, 'foreign-profile-sentinel') : root,
          localRuntime: fault === 'runtime-unknown' ? { ok: false, ready: true } : { ok: true, ready: fault !== 'runtime-negative' },
          providerPresence: () => ({ providers: [] }),
        })
        assert.equal(result.ok, false, fault)
        assert.equal(result.readyProvider, undefined, fault)
        if (fault === 'launchEnvironment') assert.equal(result.code, 'AGENT_LAUNCH_ENVIRONMENT_UNAVAILABLE')
        if (fault === 'confinement') assert.equal(result.code, 'AGENT_CONFINEMENT_UNAVAILABLE')
        if (fault === 'account') assert.equal(result.code, 'AGENT_CONFINEMENT_FOREIGN_PROFILE')
      })
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
})

test('alternate CLI readiness requires its launcher, planner, and positive provider or client presence', () => {
  for (const fault of ['launcher', 'planner', 'unknown', 'wrong-client', 'failed-presence']) {
    const root = stagePayload()
    if (fault !== 'launcher') writeFileSync(join(root, 'src/lib/agent-engine/acp-process.js'),
      'exports.startAcpSession = exports.resumeAcpSession = () => { throw Error("must not start") }; exports.ROOT_ADMISSION_CONTRACT_VERSION = 1;')
    if (fault !== 'planner') {
      const planner = join(root, HOST_MODULES.confinement)
      writeFileSync(planner, readFileSync(planner, 'utf8') + '\nmodule.exports.acpSessionPlan = () => { throw Error("must not prepare") };\n')
    }
    try {
      withInstallationProfile(root, () => {
        process.env.MC_TEST_CONFINEMENT_RESOLVED = JSON.stringify({ tier: 'guided', isolated: true })
        const result = engineAvailability({ enginePath: join(root, HOST_MODULES.engine),
          providerPresence: () => ({ ok: fault !== 'failed-presence', providers: [{ id: 'grok', installed: ['unknown', 'wrong-client'].includes(fault) ? 'unknown' : 'yes' }],
            clients: [{ provider: 'grok', client: 'antigravity', installed: 'yes' }] }),
        })
        assert.equal(result.ok, false, fault)
        assert.equal(result.code, 'AGENT_CONFINEMENT_SIGNED_OUT', fault)
      })
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
})

test('private Local readiness preserves the paired isolation policy and never reads owner provider accounts', () => {
  const previous = process.env.TOOLSENABLED_PROVIDER_ISOLATION_ROOT
  try {
    for (const paired of [true, false]) {
      const root = stagePayload()
      process.env.TOOLSENABLED_PROVIDER_ISOLATION_ROOT = root
      writeFileSync(join(root, 'src/lib/agent-engine/local-node-process.js'), 'exports.startLocalSession = () => { throw Error("must not start") }')
      const planner = join(root, HOST_MODULES.confinement)
      writeFileSync(planner, readFileSync(planner, 'utf8') + `\nmodule.exports.PROVIDER_SESSION_ISOLATION_VERSION = ${paired ? 1 : 0}; module.exports.localSessionPlan = () => { throw Error("must not prepare") };\n`)
      writeFileSync(join(root, 'src/lib/provider-session-isolation.js'),
        'exports.PROVIDER_SESSION_ISOLATION_VERSION = 1; exports.isolationContext = () => ({}); exports.resolvePrivateProviderExecutable = () => { throw Error("no private CLI installed") };')
      try {
        let ownerReads = 0
        const result = engineAvailability({ enginePath: join(root, HOST_MODULES.engine), localRuntime: { ok: true, ready: true },
          providerPresence: () => { ownerReads++; return { ok: true, providers: [{ id: 'claude', installed: 'yes' }] } },
        })
        assert.equal(ownerReads, 0, 'an isolated readiness read must not consult owner provider accounts')
        assert.equal(result.ok, paired)
        if (paired) { assert.equal(result.readyProvider, 'local'); assert.equal(result.codexCode, 'AGENT_CODEX_CLI_NOT_INSTALLED') }
        else assert.equal(result.code, 'AGENT_CONFINEMENT_UNAVAILABLE')
      } finally { rmSync(root, { recursive: true, force: true }) }
    }
  } finally {
    if (previous === undefined) delete process.env.TOOLSENABLED_PROVIDER_ISOLATION_ROOT
    else process.env.TOOLSENABLED_PROVIDER_ISOLATION_ROOT = previous
  }
})

test('private readiness cannot treat an absent isolation context or executable resolution as proof', () => {
  const previous = process.env.TOOLSENABLED_PROVIDER_ISOLATION_ROOT
  try {
    for (const absent of ['context', 'executable']) {
      const root = stagePayload()
      process.env.TOOLSENABLED_PROVIDER_ISOLATION_ROOT = root
      const planner = join(root, HOST_MODULES.confinement)
      writeFileSync(planner, readFileSync(planner, 'utf8') + '\nmodule.exports.PROVIDER_SESSION_ISOLATION_VERSION = 1; module.exports.localSessionPlan = () => { throw Error("must not prepare") };\n')
      writeFileSync(join(root, 'src/lib/agent-engine/local-node-process.js'), 'exports.startLocalSession = () => { throw Error("must not start") }')
      writeFileSync(join(root, 'src/lib/provider-session-isolation.js'),
        `exports.PROVIDER_SESSION_ISOLATION_VERSION = 1; exports.isolationContext = () => ${absent === 'context' ? 'null' : '({})'}; exports.resolvePrivateProviderExecutable = () => null;`)
      try {
        const result = engineAvailability({ enginePath: join(root, HOST_MODULES.engine),
          localRuntime: absent === 'context' ? { ok: true, ready: true } : null })
        assert.equal(result.ok, false, absent)
        assert.equal(result.code, absent === 'context' ? 'AGENT_CONFINEMENT_UNAVAILABLE' : 'AGENT_CODEX_CLI_NOT_INSTALLED')
      } finally { rmSync(root, { recursive: true, force: true }) }
    }
  } finally {
    if (previous === undefined) delete process.env.TOOLSENABLED_PROVIDER_ISOLATION_ROOT
    else process.env.TOOLSENABLED_PROVIDER_ISOLATION_ROOT = previous
  }
})

test('a confined level with no Codex sign-in is not ready', () => {
  const profileRoot = testScratch('mc-install-profile-')
  try {
    withInstallationProfile(profileRoot, () => {
      process.env.MC_TEST_CONFINEMENT_RESOLVED = JSON.stringify({ tier: 'guided', isolated: true })
      const result = engineAvailability({
        enginePath: COMPLETE_ENGINE,
        providerPresence: () => ({ providers: [{ id: 'claude', installed: 'no' }] }),
      })
      assert.equal(result.ok, false, 'a confined level cannot build a session without the sign-in it links')
      assert.equal(result.code, 'AGENT_CONFINEMENT_SIGNED_OUT', 'the refusal must name the sign-in, not the packaging')
    })
  } finally {
    rmSync(profileRoot, { recursive: true, force: true })
  }
})

test('a confined level WITH a Codex sign-in is ready', () => {
  // The converse, and the one that matters: this precondition must not report
  // a working, signed-in install as unavailable.
  const profileRoot = testScratch('mc-install-profile-')
  const home = join(profileRoot, '.codex')
  try {
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'auth.json'), '{"tokens":"redacted"}')
    withInstallationProfile(profileRoot, () => {
      process.env.MC_TEST_CONFINEMENT_RESOLVED = JSON.stringify({ tier: 'guided', isolated: true })
      const result = engineAvailability({
        enginePath: COMPLETE_ENGINE,
        providerPresence: () => ({ providers: [{ id: 'claude', installed: 'no' }] }),
      })
      assert.equal(result.ok, true, 'a signed-in confined install must report ready')
      assert.equal(result.code, 'AGENT_ENGINE_READY')
    })
  } finally {
    rmSync(profileRoot, { recursive: true, force: true })
  }
})

test('an unrestricted level still requires the installation-owned Codex sign-in', () => {
  /* Unrestricted changes machine reach, not account ownership. The current
     planner isolates every tier in a generated assistant home and links the
     Codex sign-in from the installation-owned profile, so readiness must not
     offer a start that the same planner will refuse. */
  const profileRoot = testScratch('mc-install-profile-')
  try {
    withInstallationProfile(profileRoot, () => {
      process.env.MC_TEST_CONFINEMENT_RESOLVED = JSON.stringify({ tier: 'unrestricted', isolated: true })
      const result = engineAvailability({
        enginePath: COMPLETE_ENGINE,
        providerPresence: () => ({ providers: [{ id: 'claude', installed: 'no' }] }),
      })
      assert.equal(result.ok, false, 'an unrestricted start was offered without the Codex sign-in its generated home links')
      assert.equal(result.code, 'AGENT_CONFINEMENT_SIGNED_OUT')
    })
  } finally {
    rmSync(profileRoot, { recursive: true, force: true })
  }
})

test('the sign-in probe fails OPEN when it cannot resolve the recorded level', () => {
  /* A planner that satisfies the account fence but predates the read-only
     recorded-level question must leave readiness exactly as it was. The three
     fence exports are mandatory and fail closed; resolveAgentConfinement is the
     optional probe seam whose absence means only "I could not tell". */
  const root = stagePayload()
  try {
    const planner = join(root, ...HOST_MODULES.confinement.split('/'))
    writeFileSync(planner, "'use strict'\nmodule.exports = { confinedSessionPlan: () => ({ ok: true }), installationProfileRoot: () => process.cwd(), assertAccountProfilePath: value => value, assertAccountProfileEnvironment: value => value }\n")
    const profileRoot = testScratch('mc-install-profile-')
    try {
      withInstallationProfile(profileRoot, () => {
        const result = engineAvailability({ enginePath: join(root, ...HOST_MODULES.engine.split('/')) })
        assert.equal(result.ok, true, 'an absent optional level reading must not be turned into an unavailable product')
      })
    } finally {
      rmSync(profileRoot, { recursive: true, force: true })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the sign-in the probe looks for is declared the way the host declares every payload module', () => {
  /* THE DUPLICATION, CHECKED AS FAR AS A TRACKED FILE CAN CHECK IT.
     shell/agent-host.cjs rebuilds the credential path because the payload module
     exports no read-only sign-in probe -- linkCredential() is private and
     writes. Both sides therefore derive `.codex` from the installation-owned
     profile. A copy nobody compares is how two answers to one question drift.

     THIS HALF IS UNCONDITIONAL because it reads only tracked files. An earlier
     version of this test read capability/src/lib/agent-session-confinement.js
     directly and passed here while failing in any clean checkout: `capability/`
     is DERIVED OUTPUT and gitignored, so it does not exist until
     `npm run pack:capability` cuts it. Proven by materialising the committed
     tree with `git archive` and running the suite there -- the payload was
     absent and this was the only red test. Payload-shape checks belong to the
     build pipeline (`npm run dist` runs check-payload-current, check-asar-
     manifest and check-payload-boundary), which is where the payload is
     guaranteed to exist; `npm test` must not depend on it. */
  const host = read('shell/agent-host.cjs')
  assert.match(host, /const profileRoot = planner\.installationProfileRoot\(\)/, 'the probe must ask the planner which account owns the installation')
  assert.match(host, /path\.join\(profileRoot, '\.codex'\)/, 'the probe must resolve Codex sign-in below the installation-owned profile')
  assert.doesNotMatch(host.slice(host.indexOf('function confinedSessionIsSignedOut'), host.indexOf('function codexCommandIsMissing')), /process\.env\.CODEX_HOME|os\.homedir\(\)/,
    'the sign-in probe must not follow ambient home variables into the account that launched the app')
  assert.match(host, /'auth\.json'/, 'the probe must look for the credential file the payload links')
  assert.match(host, /PAYLOAD_CONFINEMENT_MODULE = 'src\/lib\/agent-session-confinement\.js'/, 'the module the probe questions must still be the declared one')

  const manifest = JSON.parse(read('tools/capability-manifest.json'))
  assert.ok(
    manifest.hostModules.includes('src/lib/agent-session-confinement.js'),
    'the module that owns the sign-in refusal must be staged as a hostModule, or the probe questions something no customer has',
  )
})

test('the payload, when one is staged, still links the credential the probe expects', () => {
  /* THE OTHER HALF, and it is CONDITIONAL rather than skipped-in-disguise: the
     assertions below are the real drift check, and they run on every machine
     that has cut a payload -- which is every machine that can build an
     installer, including the one that cuts releases. On a bare checkout there
     is nothing to compare against and this reports that in its name rather than
     pretending to have checked. The unconditional test above is what holds when
     this cannot run. */
  const payloadPath = resolve(ROOT, 'capability/src/lib/agent-session-confinement.js')
  if (!existsSync(payloadPath)) {
    assert.ok(true, 'no payload is staged in this checkout, so there is nothing to compare')
    return
  }
  const payload = readFileSync(payloadPath, 'utf8')
  assert.match(payload, /const accountProfileBoundary = require\('\.\/account-profile-boundary'\);/,
    'the payload must load the shared account boundary that derives the installation owner')
  assert.match(payload, /const \{[\s\S]*?installationProfileRoot,[\s\S]*?assertAccountProfilePath,[\s\S]*?\} = accountProfileBoundary;/,
    'the confinement planner must use the shared installation-owner and path checks')
  assert.match(payload, /userCodexHome \|\| path\.join\(boundaryHome, '\.codex'\)/,
    'the payload must still source the ordinary Codex sign-in below the installation-owned profile; the probe copies that construction')
  assert.doesNotMatch(payload.slice(payload.indexOf('function prepareConfinedCodexHome'), payload.indexOf('function prepareConfinedClaudeHome')), /process\.env\.CODEX_HOME|os\.homedir\(\)/,
    'the confined Codex plan must not recover an ambient account through CODEX_HOME or os.homedir')
  /* THE CREDENTIAL NAME MOVED, AND THE INVARIANT DID NOT. This used to match
     `path.join(userHome, 'auth.json')` in the payload, because that is the
     construction shell/agent-host.cjs copies at line 726 to decide whether a
     person is signed out. The payload stopped hardcoding it: linkCredential()
     now takes `signInFile` as a REQUIRED parameter so one function serves both
     providers, from the single table multi-account/registry.js keeps.

     So this drift check fired correctly and pointed at a change that is not a
     defect -- for a Codex home the resolved name is still auth.json, which is
     what the host probe assumes. Matching the old literal again would just be
     re-pinning a construction that legitimately moved. Pin the thing the probe
     actually depends on instead: the registry's name for codex. That is
     strictly stronger, because the old regex would have stayed green if the
     registry had started naming something else while a stale literal survived
     somewhere in the file. */
  // Execute the staged helper with synthetic sign-in bytes. Its optional
  // no-copy policy can evolve without weakening the credential-name contract.
  const linkStart = payload.indexOf('function linkCredential(')
  const linkEnd = payload.indexOf('\n}\n', linkStart) + 2
  assert.ok(linkStart >= 0 && linkEnd > linkStart, 'the credential linking helper must remain identifiable')
  const require = createRequire(import.meta.url)
  const fs = require('node:fs')
  const linkCredential = runInNewContext(`(${payload.slice(linkStart, linkEnd)})`, {
    fs, path: require('node:path'),
    AgentConfinementRefusal: class extends Error {
      constructor(code, message) { super(message); this.code = code }
    },
  })
  const scratch = testScratch('mc-credential-name-')
  try {
    const source = join(scratch, 'named-account'), target = join(scratch, 'generated-account')
    mkdirSync(source)
    mkdirSync(target)
    writeFileSync(join(source, 'auth.json'), 'synthetic credential')
    assert.equal(linkCredential(source, target, 'auth.json', { allowCopy: false }), 'hardlink')
    const before = fs.statSync(join(source, 'auth.json'), { bigint: true })
    const linked = fs.statSync(join(target, 'auth.json'), { bigint: true })
    assert.equal(linked.dev, before.dev)
    assert.equal(linked.ino, before.ino, 'the selected credential must remain one refreshable file')
    writeFileSync(join(source, 'auth.json'), 'synthetic refreshed credential')
    assert.equal(readFileSync(join(target, 'auth.json'), 'utf8'), 'synthetic refreshed credential')
    assert.throws(() => linkCredential(source, target, 'absent-sign-in.json'), { code: 'AGENT_CONFINEMENT_SIGNED_OUT' })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  const registry = readFileSync(resolve(ROOT, 'capability/src/lib/multi-account/registry.js'), 'utf8')
  assert.match(registry, /codex: Object\.freeze\(\{[^}]*signInFile: 'auth\.json'[^}]*\}\)/,
    "the registry still names auth.json for a Codex home; shell/agent-host.cjs hardcodes that name to answer"
    + ' AGENT_CONFINEMENT_SIGNED_OUT, so if this moves the probe reports the wrong sign-in state')
  assert.match(payload, /'AGENT_CONFINEMENT_SIGNED_OUT'/, 'the payload still raises the code the probe reports')
  assert.match(payload, /confinement\.isolated !== true/, 'the payload still builds a confined home only for an isolated level')
})

test('a bad working directory outranks a missing planner, because construction does', () => {
  /* The bootstrap account fence can reject a sibling profile without executing
     the engine planner. Inside the owned profile it can therefore ask the same
     OS cwd question the eventual spawn asks before requiring the full planner.
     This preserves the construction order without weakening the account fence. */
  const root = stagePayload({ omit: ['confinement'] })
  const cwdRoot = testScratch('mc-agent-cwd-')
  try {
    const archive = join(cwdRoot, 'resources', 'app.asar')
    mkdirSync(join(cwdRoot, 'resources'), { recursive: true })
    writeFileSync(archive, 'not a directory')
    const enginePath = join(root, ...HOST_MODULES.engine.split('/'))

    assert.equal(
      engineAvailability({ enginePath, defaultCwd: archive }).code,
      'AGENT_HOST_INVALID_CWD',
      'the probe must report the fault the host construction hits first',
    )
    assert.throws(
      () => createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath, defaultCwd: archive }),
      (error) => {
        assert.equal(error.code, 'AGENT_HOST_INVALID_CWD', 'construction must refuse the unusable cwd before loading the full planner')
        return true
      },
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cwdRoot, { recursive: true, force: true })
  }
})

test('availability refuses a working directory the spawn cannot use', () => {
  // The third dev-only-works bug, asked as a READINESS question. A packaged
  // build whose workspace resolved inside the archive reported ready and then
  // died at CreateProcess on every start.
  const root = testScratch('mc-agent-cwd-')
  try {
    const archive = join(root, 'resources', 'app.asar')
    mkdirSync(join(root, 'resources'), { recursive: true })
    writeFileSync(archive, 'not a directory')
    const result = engineAvailability({ enginePath: COMPLETE_ENGINE, defaultCwd: archive })
    assert.equal(result.ok, false, 'a cwd the spawn will refuse must not be reported ready')
    assert.equal(result.code, 'AGENT_HOST_INVALID_CWD', 'the refusal must name the working directory, not the engine')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the probe and the start agree, code for code, on every incomplete payload', async () => {
  /* THE ANTI-DRIFT TEST, and the only one here that reads both sources at once.
     Each case below asks the SAME installation two questions -- "are you ready"
     and "start a session" -- and requires one answer. Every other test in this
     block could pass while the two drifted apart again; this one cannot.

     createAgentHost() is what a start goes through, so the comparison is
     against the real construction and start, not against a re-reading of
     availability's own logic. */
  /* The fixture planner answers with whatever MC_TEST_CONFINEMENT_PLAN holds
     and refuses by default, which would make every case below stop at the
     confinement check and never reach the one it is about. Staging a plan that
     SUCCEEDS is what lets the launch-environment case be measured at all. */
  const previousPlan = process.env.MC_TEST_CONFINEMENT_PLAN
  process.env.MC_TEST_CONFINEMENT_PLAN = JSON.stringify({
    ok: true, tier: 'unrestricted', isolated: false,
    threadOptions: { sandbox: 'danger-full-access', approvalPolicy: 'never' }, env: null,
  })
  const cases = [
    ['no confinement planner', { omit: ['confinement'] }, 'AGENT_CONFINEMENT_UNAVAILABLE'],
    ['no launch-environment scrub', { omit: ['launchEnvironment'] }, 'AGENT_LAUNCH_ENVIRONMENT_UNAVAILABLE'],
  ]
  try {
  for (const [label, staging, expected] of cases) {
    const root = stagePayload(staging)
    try {
      const enginePath = join(root, ...HOST_MODULES.engine.split('/'))
      const probe = engineAvailability({ enginePath })
      assert.equal(probe.code, expected, `${label}: the probe must report ${expected}`)
      assert.equal(probe.ok, false, `${label}: the probe must not report ready`)

      let started = null
      try {
        const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath, defaultCwd: root })
        await host.startSession({ sessionId: `probe-${label}` })
      } catch (error) {
        started = error
      }
      assert.ok(started, `${label}: the start must actually fail, or the probe is refusing a working install`)
      assert.equal(
        started.code,
        probe.code,
        `${label}: readiness and startability must be computed from one source -- the probe said ${probe.code} and the start said ${started.code}`,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
  } finally {
    if (previousPlan === undefined) delete process.env.MC_TEST_CONFINEMENT_PLAN
    else process.env.MC_TEST_CONFINEMENT_PLAN = previousPlan
  }
})

/* ------------------------------------------------------------------
   A REFUSAL NOBODY CAN READ IS A REFUSAL NOBODY CAN ACT ON.

   The main-process message names the missing module and the manifest that
   should have staged it -- and also names an absolute engine root, so it can
   never cross the bridge. The CODE carries that specificity instead, which only
   works if every surface that shows a code has a sentence for it.
   ------------------------------------------------------------------ */

test('the signed-out availability reason names the reader\'s computer', () => {
  const code = 'AGENT_CONFINEMENT_SIGNED_OUT'
  const desk = 'This session needs a Codex sign-in, and this computer does not hold one. The permission level recorded here builds each session from that sign-in. If Codex is installed, open a new terminal window and run "codex login". If it is not, run "winget install OpenAI.Codex" first. Then come back to this screen'

  assert.equal(unavailableReason(code), desk, 'the local reader keeps the desk sentence byte for byte')
  assert.equal(UNAVAILABLE_TEXT[code], desk, 'the frozen desk table remains the local source')

  const remote = unavailableReason(code, { subject: AVAILABILITY_SUBJECT_REMOTE })
  assert.match(remote, /the computer you are driving does not hold one/)
  assert.match(remote, /on that computer open a new terminal window/)
  assert.doesNotMatch(remote, /this computer/)
  assert.notEqual(remote, desk)
})

test('every code availability can return has a specific sentence on both surfaces', () => {
  /* MAPPED EXPLICITLY, not merely "different from the fallback". "This copy is
     not set up to run agents yet" is the fallback AND the deliberate, correct
     sentence for AGENT_ENGINE_UNAVAILABLE, so a difference test would force
     that one entry to be reworded into something less true. The property that
     actually matters is that a code was CONSIDERED. */
  const noEngine = ENGINE_REASON.AGENT_ENGINE_UNAVAILABLE
  /* BOTH HALVES of the composed answer. mc-agent:availability returns the
     RECORDER's verdict when a record cannot be written and the ENGINE's when it
     can, and both reach the page carrying the Start control -- so walking only
     the engine codes was itself a list of two of three preconditions. */
  for (const code of [...RECORD_AVAILABILITY_CODES, ...AVAILABILITY_CODES]) {
    const page = unavailableReason(code)
    assert.ok(Object.hasOwn(UNAVAILABLE_TEXT, code), `the agent page has no entry for ${code}, so it would show the bare code`)
    assert.notEqual(page, code, `the agent page shows the bare code for ${code} instead of a sentence`)
    assert.ok(page.length > 20, `the agent page's copy for ${code} is too short to act on: ${page}`)

    assert.ok(Object.hasOwn(ENGINE_REASON, code), `the home screen has no entry for ${code} and would fall back to generic copy`)
    const home = readAgentEngine({ ok: false, code }).why
    assert.equal(home, ENGINE_REASON[code], `readAgentEngine does not render the home screen's own entry for ${code}`)
    assert.equal(readAgentEngine({ ok: false, code }).ready, false, `${code} must never read as ready`)

    /* A copy is not "not set up to run agents" when its engine resolved and one
       sibling module is missing -- that sentence sends a person to reinstall
       for a fault that has nothing to do with configuration. */
    if (code !== 'AGENT_ENGINE_UNAVAILABLE') {
      assert.notEqual(home, noEngine, `${code} reuses the no-engine sentence, which is untrue of an installation whose engine resolved`)
    }
  }
})

test('every refusal the probe never answers still reaches a person as a sentence', () => {
  /* THE GAP THIS CLOSES. The walk above covers AVAILABILITY_CODES and
     RECORD_AVAILABILITY_CODES -- what the readiness probe can answer. Four
     codes reach the same two surfaces WITHOUT the probe ever answering them:
     AGENT_HOST_CLOSED and MC_AGENT_INVALID_PAYLOAD (raised on the call itself)
     and CODEX_CLI_NOT_FOUND / CODEX_VERSION_DETECTION_FAILED (raised by the
     engine at start time, after readiness has already said yes). They had a
     sentence in both tables and NOTHING REQUIRED THEM TO, which is the same
     defect class the recorder half was repaired for: the coverage list and the
     copy list were maintained by different hands and only one was checked.

     Each is asserted the way it is actually experienced -- through
     refusalCode(), which is how a code survives the IPC boundary at all, then
     through the sentence each surface renders. */
  for (const code of START_REFUSAL_CODES) {
    assert.equal(
      refusalCode(new Error(code)),
      code,
      `${code} does not survive the IPC boundary: refusalCode() cannot recover it from the error message, so the page shows AGENT_SESSION_FAILED instead`,
    )

    assert.ok(Object.hasOwn(UNAVAILABLE_TEXT, code), `the agent page has no entry for ${code}, so it would show the bare code`)
    const page = unavailableReason(code)
    assert.notEqual(page, code, `the agent page shows the bare code for ${code} instead of a sentence`)
    assert.ok(page.length > 20, `the agent page's copy for ${code} is too short to act on: ${page}`)

    assert.ok(Object.hasOwn(ENGINE_REASON, code), `the home screen has no entry for ${code} and would fall back to generic copy`)
    const home = readAgentEngine({ ok: false, code }).why
    assert.equal(home, ENGINE_REASON[code], `readAgentEngine does not render the home screen's own entry for ${code}`)
    assert.equal(readAgentEngine({ ok: false, code }).ready, false, `${code} must never read as ready`)
  }

  /* AND THE LIST MAY NOT SHRINK TO FIT. Same reasoning as the recorder half:
     a coverage list walked by a copy test can always be made green by deleting
     the entry that was failing, so each member is tied back to something that
     really raises it. The two engine-side codes are raised in the payload's
     codex-process.js, outside this repo, so they are tied to the boundary that
     admits them instead: refusalCode()'s table, asserted above. */
  assert.ok(read('shell/agent-host.cjs').includes("fail('AGENT_HOST_CLOSED'"),
    'AGENT_HOST_CLOSED is listed as a start refusal but the host no longer raises it')
  assert.ok(read('shell/main.cjs').includes("'MC_AGENT_INVALID_PAYLOAD'"),
    'MC_AGENT_INVALID_PAYLOAD is listed as a start refusal but the agent IPC frame validator no longer raises it')
  assert.ok(read('shell/agent-host.cjs').includes("fail('AGENT_TIER_NO_LAUNCHER'"),
    'AGENT_TIER_NO_LAUNCHER is listed as a start refusal but resolveStartTier() no longer raises it')
  assert.ok(read('shell/agent-host.cjs').includes("fail('AGENT_ROLE_BINDING_INVALID'"),
    'AGENT_ROLE_BINDING_INVALID is listed as a start refusal but authoritative role validation no longer raises it')
  assert.equal(new Set(START_REFUSAL_CODES).size, START_REFUSAL_CODES.length, 'the start-refusal vocabulary repeats a code')
  for (const code of START_REFUSAL_CODES) {
    assert.equal(AVAILABILITY_CODES.includes(code), false,
      `${code} is in both vocabularies; a start-only code in AVAILABILITY_CODES fails the host's own classification test`)
    assert.equal(RECORD_AVAILABILITY_CODES.includes(code), false, `${code} is in both vocabularies`)
  }
})

test('the two surfaces name the same fault in their own register', () => {
  // Two tables exist because a home screen and a spawn control speak
  // differently, not because the product has two opinions. Each pair must be
  // about the same thing, and neither may be the other's text verbatim.
  for (const code of ['AGENT_CONFINEMENT_UNAVAILABLE', 'AGENT_LAUNCH_ENVIRONMENT_UNAVAILABLE']) {
    assert.notEqual(UNAVAILABLE_TEXT[code], ENGINE_REASON[code], `${code} has the same sentence on both surfaces; one of them is in the wrong register`)
    assert.ok(/will not start/.test(ENGINE_REASON[code]), `${code} must tell a home-screen reader what the consequence is`)
  }
  /* THE MODULE NAME IS STILL REQUIRED, AND IT MOVED OFF THE GLASS.
   *
   * These two lines used to assert that "(agent-session-confinement)" and
   * "(subscription-launch-env)" appeared IN THE SENTENCE, on the grounds that
   * the main-process message names the missing module and can never cross the
   * bridge, so if the name is nowhere a support conversation has nothing to go
   * on. That reason is right. The place was wrong: it put an internal module
   * name, in brackets, mid-sentence, in front of a customer whose only available
   * action is to reinstall.
   *
   * It is the identical situation src/refusal-copy.js settled for codes -- the
   * identifier is a machine field on `data-refusal-code`, never in the prose --
   * so the module name is now a machine field too, in MISSING_MODULE. BOTH
   * HALVES ARE ASSERTED, because either one alone reintroduces a defect: drop
   * the first and the name can vanish entirely, drop the second and it can go
   * back into the sentence. */
  assert.equal(MISSING_MODULE.AGENT_CONFINEMENT_UNAVAILABLE, 'agent-session-confinement',
    'the missing module must stay nameable somewhere a support conversation can reach it')
  assert.equal(MISSING_MODULE.AGENT_LAUNCH_ENVIRONMENT_UNAVAILABLE, 'subscription-launch-env',
    'the missing module must stay nameable somewhere a support conversation can reach it')
  for (const [code, name] of Object.entries(MISSING_MODULE)) {
    assert.ok(Object.hasOwn(UNAVAILABLE_TEXT, code), `${code} names a missing module and has no sentence`)
    assert.ok(!UNAVAILABLE_TEXT[code].includes(name),
      `${code} puts the module name "${name}" in front of a person: ${UNAVAILABLE_TEXT[code]}`)
  }
  for (const text of Object.values(UNAVAILABLE_TEXT)) {
    assert.doesNotMatch(text, /[\\]|[A-Za-z]:\/|(?:^|\s)\/(?:home|Users|tmp|var)\//, 'no refusal sentence may carry a filesystem path')
  }
})

test('every refusal the start CHANNEL raises reaches the person as a reason, not as "we were not told why"', () => {
  /* THE GAP THIS CLOSES, and it is one level up from the two walks above.
   *
   * Those walk what the HOST and the RECORDER can answer. Ten more refusals are
   * raised by shell/main.cjs on the mc-agent:start channel itself, before the
   * host is ever reached: the trusted-sender check, the payload parse, the
   * session-profile resolve, the session limit, and the spawn recorder. Every
   * one of them crossed the IPC boundary correctly -- rendererSafeAgentError
   * makes the message the code precisely so it survives -- and then fell
   * through startRefusalSentence() to START_REFUSAL.noReasonGiven, "Nothing was
   * started, and this copy was not told why. Try once more."
   *
   * The copy WAS told why. And "try once more" is worse than saying nothing,
   * because not one of these clears on a second press: the limit is still
   * reached, the folder is still gone, the record still cannot be written.
   *
   * THE LIST IS READ FROM THE SOURCE, never typed here, so a refusal added to
   * that channel later fails this test instead of quietly reaching a person as
   * the no-reason sentence. The profile family is read the same way: the start
   * path rethrows sessionProfiles.resolveCwd's code with an MC_AGENT_ prefix,
   * so the codes come from shell/session-profiles.cjs. */
  /* Read from BOTH homes after the command-surface extraction: the parsers and
     the record gate still raise in main.cjs, the session/limit/attachment
     refusals raise in shell/agent-command-surface.cjs. */
  const main = read('shell/main.cjs') + '\n' + read('shell/agent-command-surface.cjs')
  const channelCodes = new Set([...main.matchAll(/'(MC_AGENT_[A-Z_]+)'/g)].map(match => match[1]))
  /* Prefix literals used to preserve a bounded family are not complete codes.
     Dropping them here rather than loosening the pattern keeps the pattern
     honest about what a code looks like. */
  channelCodes.delete('MC_AGENT_')
  channelCodes.delete('MC_AGENT_ROLE_')
  /* THE SURFACE'S OWN GATES, WHICH THE WINDOW CANNOT REACH. The shared surface
     refuses a caller that is not the documented principal shape, a read-only
     principal's writes, a dialog to a principal not at the keyboard, and a
     command it does not hold. main.cjs's wrappers construct only the window
     principal (valid, mayWrite:true, kind 'window') and name only commands the
     surface holds, so none of these can cross the IPC boundary today. Paste
     likewise requires that same window principal, before parsing any bytes. The
     relay facade that will reach them needs its own copy in its own binding
     (design §3: the binding re-throws the code and refusalCode() reads it) --
     that is that pass's obligation, not a sentence missing here. Each is
     listed by name so a NEW surface-only code is still caught. */
  for (const unreachableFromWindow of [
    'MC_AGENT_PRINCIPAL_READ_ONLY',
    'MC_AGENT_DIALOG_REQUIRES_WINDOW',
    'MC_AGENT_PASTE_REQUIRES_WINDOW',
    'MC_AGENT_PRINCIPAL_INVALID',
    'MC_AGENT_UNKNOWN_COMMAND',
    /* CONNECTION_CLOSED joined this list with the remote-connection fence. It
       is raised by relayPrincipal() in shell/main.cjs -- a factory that builds
       the RELAY principal and nothing else -- when remote access is stopping or
       the fence has withdrawn it. The window's own principal is constructed on
       a different path and never passes through it, so like the five above this
       code cannot cross the window IPC boundary and a start sentence for it
       would describe an act the person did not perform. It is not uncovered:
       tools/test/remote-connection-main-wiring.test.mjs pins that it reaches the
       relay's own wire as `error.code`, which is the binding this list's comment
       above names as owning the copy. The delete() assertion still binds it --
       the day it stops being raised, this line fails. */
    'MC_AGENT_CONNECTION_CLOSED',
  ]) {
    assert.ok(channelCodes.delete(unreachableFromWindow), `${unreachableFromWindow} is no longer raised by the surface; drop it from this list`)
  }
  /* Paste does not start an agent. These exact codes still have to survive
     the real error-message boundary and reach their own actionable copy;
     putting them through startRefusalSentence would describe the wrong act.
     New codes remain in the census until their actual consumer is reviewed. */
  const paste = surfaceBody('agent:paste-attachment')
  assert.match(paste, /windowOnly\(principal, 'agent:paste-attachment'\)/)
  assert.match(paste, /agentIpcError\(PASTE_UNAVAILABLE_REFUSAL/)
  assert.match(paste, /'MC_AGENT_PASTE_IMAGE_TOO_LARGE'/)
  for (const [code, expected] of [
    ['MC_AGENT_PASTE_UNAVAILABLE', unavailableReason('MC_AGENT_PASTE_UNAVAILABLE')],
    ['MC_AGENT_PASTE_IMAGE_TOO_LARGE', PALETTE_PANEL.pasteTooLarge],
  ]) {
    assert.ok(channelCodes.delete(code), `${code} is no longer raised; review its paste-only classification`)
    const wrapped = new Error(`Error invoking remote method 'mc-agent:paste-attachment': Error: ${code}`)
    for (const error of [new Error(code), wrapped, { code }]) {
      const sentence = pasteRefusalSentence(error)
      assert.equal(sentence, expected, `${code} lost its specific paste remedy at the IPC boundary`)
      assert.ok(sentence.length > 40 && sentence.split(/(?<=[.!?])\s/).length >= 2,
        `${code} has no actionable paste remedy`)
      assert.doesNotMatch(sentence, /MC_AGENT_/, 'a paste code reached the visible sentence')
    }
  }
  /* A REFUSAL THAT IS RETURNED, NEVER THROWN, AND SO NEVER CROSSES AS A CODE.
   *
   * MEASURED, 2026-09-16: the T18 commit 9623a4bc added
   * MC_AGENT_IMAGE_TOO_LARGE_TO_DELIVER to this surface and left it
   * unclassified here, which turned this census RED -- and that red is in the
   * cut (dc51d324), in the generation the owner is running. The census was
   * right and the commit was wrong to leave it out; its own note says "New
   * codes remain in the census until their actual consumer is reviewed".
   *
   * THE REVIEW. pictureTooLargeToDeliver() does not call agentIpcError. It
   * RETURNS `{ ok: false, code, sentence }`, and both attachment doors hand
   * that object straight to the composer, which reads `sentence` and shows it
   * (src/components.js chooseAttachment and attachPastedImage). The code never
   * becomes an Error, never crosses the IPC boundary, and never reaches
   * refusalCode() or any copy table -- so requiring it to survive as a code, or
   * to carry a start sentence, would be asserting a journey it does not make.
   *
   * THE CLASSIFICATION IS NOT TAKEN ON TRUST. Each assertion below is the
   * property that MAKES it true, so the day one of these codes is thrown
   * instead of returned, or loses the sentence it travels with, this fails
   * rather than sitting here as a stale exemption. */
  for (const returnedNeverThrown of ['MC_AGENT_IMAGE_TOO_LARGE_TO_DELIVER']) {
    assert.ok(channelCodes.delete(returnedNeverThrown),
      `${returnedNeverThrown} is no longer raised by the surface; drop it from this list`)
    assert.doesNotMatch(main, new RegExp(`agentIpcError\\(\\s*'${returnedNeverThrown}'`),
      `${returnedNeverThrown} is now THROWN as well as returned, so it crosses the IPC boundary and needs a sentence like every other code here`)
    assert.match(main, new RegExp(`code:\\s*'${returnedNeverThrown}',\\s*\\n\\s*sentence:`),
      `${returnedNeverThrown} is returned to the composer without the sentence it is exempt on account of carrying`)
  }

  const profiles = read('shell/session-profiles.cjs')
  for (const [, code] of profiles.matchAll(/refusal\('(PROFILE_[A-Z_]+)'/g)) {
    /* Only the ones a START can reach: resolveCwd is what mc-agent:start calls,
       and the create/remove refusals belong to their own controls. */
    if (code === 'PROFILE_UNKNOWN' || code.startsWith('PROFILE_FOLDER_')) channelCodes.add(`MC_AGENT_${code}`)
  }

  assert.ok(channelCodes.size >= 10,
    `only ${channelCodes.size} refusal codes were found in the start channel; the reader has drifted from the source`)

  /* NOT EVERY CODE ON THESE CHANNELS IS A START, and composing a send refusal
     behind "Nothing was started." would be the product asserting something it
     does not know. Each entry here is send-only for a stated reason and is
     still required to carry copy, one assertion further down. */
  const sendOnly = new Set([
    // Raised by mc-agent:send when a message names a file that was not picked
    // in that session. A session IS open and running; what failed is the
    // message.
    'MC_AGENT_ATTACHMENT_UNKNOWN',
    // Raised by send, interrupt and close for a session this RUN does not
    // hold. It already has its own sentence in the start table too, because a
    // tree node can outlive its session.
    'MC_AGENT_UNKNOWN_SESSION',
  ])

  for (const code of channelCodes) {
    assert.equal(refusalCode(new Error(code)), code,
      `${code} does not survive the IPC boundary: refusalCode() cannot recover it, so the panel shows AGENT_SESSION_FAILED instead`)
    assert.ok(Object.hasOwn(UNAVAILABLE_TEXT, code),
      `${code} has no sentence, so a person who hits it is told this copy was not told why`)
    if (sendOnly.has(code)) continue
    const sentence = startRefusalSentence({ ok: false, code })
    assert.notEqual(sentence, START_REFUSAL.noReasonGiven,
      `${code} reaches the compose panel as the no-reason sentence, which also tells the person to try again when trying again cannot work`)
    assert.ok(sentence.length > 40, `the sentence for ${code} is too short to act on: ${sentence}`)
    /* Rule 3 of the flow's copy: every failure sentence ends with something to
       do. Asserted as "the sentence has a second clause", which is the weakest
       thing that can distinguish a diagnosis from a diagnosis plus a remedy. */
    assert.ok(sentence.split(/(?<=[.!?])\s/).length >= 2,
      `the sentence for ${code} states a problem and offers no next step: ${sentence}`)
  }
})

test('research start refusals survive wrapped and plain IPC errors with actionable copy', () => {
  const cases = [
    'MC_AGENT_RESEARCH_INVALID',
    'AGENT_RESEARCH_SCOPE_UNAVAILABLE',
  ]
  for (const expected of cases) {
    const errors = [
      new Error(expected),
      new Error(`Error invoking remote method 'mc-agent:start': Error: ${expected}`),
    ]
    for (const error of errors) {
      const recovered = refusalCode(error)
      assert.equal(recovered, expected)
      assert.equal(typeof UNAVAILABLE_TEXT[recovered], 'string')
      const sentence = startRefusalSentence({ ok: false, code: recovered })
      assert.notEqual(sentence, START_REFUSAL.noReasonGiven)
      assert.doesNotMatch(sentence, /MC_AGENT_|AGENT_RESEARCH_/)
      assert.match(sentence, /research|boundary|reopen|check|try|update/i)
    }
  }
})

test('a code with no copy still refuses, rather than degrading to ready', () => {
  // The fallback direction. An unmapped code is a copy gap, and a copy gap must
  // never become an enabled control -- both surfaces branch on `ok`, never on
  // whether they recognise the code.
  const unknown = readAgentEngine({ ok: false, code: 'AGENT_SOMETHING_NEW' })
  assert.equal(unknown.ready, false)
  assert.equal(unknown.supported, true)
  assert.ok(unknown.why, 'an unrecognised code must still produce a sentence')
  assert.equal(readAgentEngine({}).ready, false, 'a malformed reply must not read as ready')
  assert.equal(readAgentEngine(undefined).ready, false, 'no answer at all must not read as ready')

  const surface = read('src/agent-session.js')
  assert.match(
    surface,
    /if \(available\?\.ok !== true\) \{/,
    'the agent page must gate Start on ok, never on whether it recognises the code',
  )
})

test('every refusal code in the agent host is classified as reachable from the probe or not', () => {
  /* MECHANICAL, so a precondition added later cannot quietly return a code no
     surface can translate. Every fail() in shell/agent-host.cjs is collected
     from the source and must appear in exactly one of the two sets below --
     AVAILABILITY_CODES (which the copy test above walks) or the start-only list
     here, each entry of which is start-only for a stated reason. A new code
     lands in neither and fails this test. */
  const startOnly = new Set([
    /* AGENT_HOST_CLOSED used to be a bare literal here. It is now taken from
       START_REFUSAL_CODES so "start-only" and "must carry copy" are the same
       statement about the same code, made once. Deleting it from that list
       fails the copy walk above AND leaves it unclassified here. */
    ...START_REFUSAL_CODES,
    /* Restricted research is admitted by a one-use owner-host permit created
       for the requested start. The availability probe has no research permit
       or boundary to inspect, so these enforcement refusals are start-only;
       both carry the copy walked above. */
    'AGENT_RESEARCH_SCOPE_UNAVAILABLE',
    'AGENT_RESEARCH_TOOL_RESTRICTION_UNAVAILABLE',
    // Raised while a session is running or being torn down; there is nothing
    // for a readiness probe to resolve.
    'AGENT_ENGINE_INVALID_SESSION',
    'AGENT_ENGINE_INVALID_TURN',
    'AGENT_SESSION_UNKNOWN',
    'AGENT_SESSION_ENDED',
    // Private readTreeParent() authority read on an already running circle;
    // delegation/bounded-start boundaries translate this into their refusal.
    'AGENT_TREE_PARENT_UNAVAILABLE',
    'AGENT_SESSION_NOT_READY',
    'AGENT_SESSION_EXISTS',
    'AGENT_SESSION_START_CANCELLED',
    'AGENT_TURN_ACTIVE',
    'AGENT_TURN_NONE',
    // An invalid /cloud command is answered by the current chat send. A
    // readiness probe has no command text to parse and cannot produce it.
    'AGENT_CLOUD_COMMAND_INVALID',
    // Raised by updateTreeAddress() while a session is already running, for
    // the same reason as the block above: nothing for a readiness probe to
    // resolve before a start.
    'AGENT_TREE_MESSAGING_UNAVAILABLE',
    // Raised by acknowledgeTreeBatch() and the close-time queue retention
    // (T50 delivery receipts, landed for cut 1) while a session is running or
    // being torn down: an engine that cannot confirm a recovered handoff or
    // retain queued messages refuses THAT operation, and the delivery-failure
    // receipt carries the sentence. Found red at the cut-1 tip on 2026-09-16;
    // it was never classified when the code was added. Its sibling,
    // raised at the same two sites when the engine answers but does not
    // accept the receipt, is start-only for the same reason.
    'AGENT_TREE_RECOVERY_UNAVAILABLE',
    'AGENT_TREE_RECOVERY_UNCONFIRMED',
    // adoptTreeAddress() assigns an already running standalone session to
    // one saved node. An existing assignment or occupied target refuses that
    // placement only; neither is a readiness condition for starting an agent.
    'AGENT_TREE_ALREADY_ASSIGNED',
    'AGENT_TREE_NODE_OCCUPIED',
    // treeLinks() and setTreeLink() ask for directory methods only when the
    // person reads or changes direct links. An older engine can still start
    // agents without those methods, so this operation refusal cannot come
    // from the agent readiness probe and must not disable Start globally.
    'TREE_LINKS_UNAVAILABLE',
    /* Raised by resolveStartTier() only for a tier name outside START_TIERS.
       The tier menu is built from the same six names the host holds (the
       orchestration-controls suite pins the two tables together), so no click
       can produce an unknown tier -- only renderer/host drift or a hand-built
       payload can, which is MC_AGENT_INVALID_PAYLOAD's family: a malformed
       request, not a state a readiness probe could resolve or a person could
       choose. Its sibling AGENT_TIER_NO_LAUNCHER is one click away for a real
       person and therefore lives in START_REFUSAL_CODES with copy instead. */
    'AGENT_TIER_UNKNOWN',
    /* Resume refusals, iteration 7. Both are start-only for the same reason
       the tier ones are: they answer a request the person made THROUGH a
       control, and the sentence belongs to that control rather than to the
       availability screen. */
    'AGENT_RESUME_INVALID_THREAD',
    'AGENT_RESUME_UNSUPPORTED',
    'AGENT_RESUME_ACCOUNT_UNAVAILABLE',
    // startSession's exactResumeAccount branch classifies the saved owner's
    // resolver attempt. A readiness probe has no requested saved account or
    // provider thread, so it cannot reach either specific refusal.
    'AGENT_RESUME_ACCOUNT_LIMIT',
    'AGENT_RESUME_ACCOUNT_SIGNED_OUT',
    // resumeManagerName is a shape check on the same resume request; only
    // renderer/host drift or a hand-built payload can send an invalid one.
    'AGENT_RESUME_MANAGER_INVALID',
    /* Raised when the engine cannot change depth in place; the popup falls
       back to the warned restart, so the surface never dead-ends. */
    'AGENT_EFFORT_FIXED',
    'AGENT_MODELS_UNAVAILABLE',
    /* Raised by resolveEffort() only for a key outside the four the effort
       menu offers -- same family and same reasoning as AGENT_TIER_UNKNOWN
       directly above: only renderer/host drift or a hand-built payload can
       produce it, never a click, so no readiness probe could resolve it. */
    'AGENT_EFFORT_UNKNOWN',
    /* Raised by narrowTurnOptions() only when a send names a turn option that
       is not the renderer's to choose (sandbox, approvalPolicy, cwd,
       serviceTier), or by the image bound check for a malformed images array.
       The model picker offers only Codex rows and images ride only through
       the native picker's issued paths, so no click can produce either --
       only renderer/host drift or a hand-built payload can, the same
       MC_AGENT_INVALID_PAYLOAD family as AGENT_TIER_UNKNOWN above. */
    'AGENT_TURN_OPTION_FORBIDDEN',
    'AGENT_TURN_IMAGES_INVALID',
    /* Raised by treeCourierTimingOf() for a malformed treeCourier clock-
       override object or an out-of-bounds value on one of its keys. Same
       family as the tier/effort/turn-option checks above: only renderer/host
       drift or a hand-built payload can shape it wrong. */
    'AGENT_HOST_TREE_COURIER_INVALID',
    /* Standing requests (the /Request family). KEYS_INVALID is the
       MC_AGENT_INVALID_PAYLOAD family: the view sends node ids it already
       holds, so only renderer/host drift or a hand-built payload can produce
       it -- never a click. UNAVAILABLE answers the person's own typed
       command through the chat, which writes its own sentence for it
       (src/views/computers.js fileStandingRequestFor); a readiness probe has
       nothing to resolve because the absence is the payload's age. The
       R_LEDGER-mapped refusals (AGENT_REQUEST_WORDS_*, _KEY, _SCOPE, ...)
       are raised through a computed fail(code) the literal scan cannot see,
       and the same chat sentences answer them. */
    'AGENT_REQUEST_KEYS_INVALID',
    'AGENT_REQUEST_UNAVAILABLE',
    /* KIND_INVALID joined that family with the ledger kinds (shell/agent-host.cjs
       fileStandingRequest, the literal fail at the `kind !== 'T' && kind !== 'A'`
       check). It is start-only for the same reason KEYS_INVALID is: `kind` is
       computed by the renderer from which slash command the person typed -- a
       plain /Request passes none at all -- so a click cannot shape it wrong and
       no readiness probe could resolve it; only renderer/host drift or a
       hand-built payload reaches it. Unlike the R_LEDGER-mapped refusals in the
       comment above, this one IS a literal fail() the code scan sees, which is
       why it has to be named here rather than covered by that sentence. */
    'AGENT_REQUEST_KIND_INVALID',
    // The Ledger task box supplies the grade; availability has no task to grade.
    'AGENT_REQUEST_DIFFICULTY_INVALID',
    /* Raised only when a RULE filing arrives naming the chat as its door while
       the person's "Who adds standing rules" is "Ledger page only"
       (rules.filing_from, owner 2026-09-15). A readiness probe holds no
       request and names no door, so it cannot reach this; and the refusal is
       answered in the chat that attempted it, with the sentence the host
       returns, rather than through availability copy on a start surface. The
       Ledger page's own box names no door and is always let in. */
    'AGENT_REQUEST_CHAT_OFF',
    /* THE LEDGER PAGE'S OWN WRITE REFUSALS, the other four the union added, all
       raised by resolveStandingRequest() and ledgerWriteVerbId() in
       shell/agent-host.cjs. Start-only for two distinct reasons, both of which
       the family above already covers:

       ID_KIND_MISMATCH and STATUS_INVALID are the KEYS_INVALID shape -- the id
       and the status come from a row the Ledger page is already displaying and
       from the store's own RESOLUTION_STATUSES vocabulary, so a click cannot
       produce a mismatched kind letter or an unknown status; only renderer/host
       drift or a hand-built payload can.

       RESOLVE_UNAVAILABLE and WRITE_UNAVAILABLE are the AGENT_REQUEST_UNAVAILABLE
       shape -- an engine older than these verbs, answered by the page's own
       sentence. A readiness probe could not resolve either, because what is
       absent is the paired engine's method, not anything the person can set. */
    'AGENT_LEDGER_ID_KIND_MISMATCH',
    'AGENT_LEDGER_RESOLVE_UNAVAILABLE',
    'AGENT_LEDGER_STATUS_INVALID',
    'AGENT_LEDGER_WRITE_UNAVAILABLE',
    /* Raised by normalizeTreeIdentity() for a malformed treeIdentity packet
       (not an object, or keys other than selfName/managerName). The renderer
       computes this packet from the tree it already holds and sends it on
       every start; only renderer/host drift or a hand-built payload can shape
       it wrong, never a click, so no readiness probe could resolve it -- the
       same family as AGENT_TIER_UNKNOWN and AGENT_TURN_OPTION_FORBIDDEN above. */
    'AGENT_TREE_IDENTITY_INVALID',
    // Caller-supplied inbox shape is validated on attachment, not availability.
    'AGENT_TREE_INBOX_INVALID',
    /* Raised by discardContinuation() when a saved recovery no longer owns the
       session it names. It answers the continuations channel, not a start, and
       its consumer (src/account-recovery-coordinator.js) treats it as already
       closed. A readiness probe holds no continuation to check. */
    'CONTINUATION_CHANGED',
    // sendTurn requires a complete rules snapshot and rechecks the setting
    // before dispatch. Availability holds neither a turn nor a snapshot.
    'RULES_CONTEXT_UNAVAILABLE',
    'RULES_POLICY_CHANGED',
    /* setGoal() refuses an objective that is only whitespace or longer than a
       goal may carry. The person is answered at the composer before the send
       (src/slash-commands.js goalTooLongSentence / goalUsageSentence); this is
       the host's own backstop for a caller that skipped that parse, so a
       readiness probe -- which holds no objective -- cannot reach it. */
    'AGENT_GOAL_INVALID',
  ])
  const source = read('shell/agent-host.cjs')
  const plannerSource = engineFile('src/lib/agent-session-confinement.js')
  const boundarySource = engineFile('src/lib/account-profile-boundary.js')
  const found = new Set()
  for (const match of source.matchAll(/\bfail\(\s*\n?\s*'([A-Z_]+)'/g)) found.add(match[1])
  const plannerAvailability = new Set([
    'AGENT_CONFINEMENT_ACCOUNT_PROFILE_UNAVAILABLE',
    'AGENT_CONFINEMENT_WRONG_PRINCIPAL',
    'AGENT_CONFINEMENT_FOREIGN_PROFILE',
    'AGENT_CONFINEMENT_PROFILE_PATH_INVALID',
    'AGENT_CONFINEMENT_PROFILE_PATH_UNAVAILABLE',
    'AGENT_CONFINEMENT_PROFILE_REPARSE_POINT',
  ])
  // startSession() re-raises the planner's own code, which is why the literal
  // appears there as a fallback; the planner loader owns it.
  assert.ok(found.size >= 10, `the code scan found only ${found.size} refusals, so its pattern has stopped matching`)
  const classified = new Set([...AVAILABILITY_CODES, ...startOnly])
  for (const code of found) {
    assert.ok(
      classified.has(code),
      `${code} is raised by shell/agent-host.cjs but classified neither as reachable from availability (with UI copy) nor as start-only`,
    )
  }
  for (const code of AVAILABILITY_CODES) {
    assert.ok(found.has(code) || plannerAvailability.has(code),
      `${code} is exported as an availability code but neither the host nor the planner path check raises it`)
    if (plannerAvailability.has(code)) {
      assert.ok(plannerSource.includes(`'${code}'`) || boundarySource.includes(`'${code}'`),
        `${code} is attributed to the staged planner or its shared boundary but neither raises it`)
    }
  }
  for (const code of plannerAvailability) {
    assert.ok(AVAILABILITY_CODES.includes(code), `${code} can escape the planner's readiness path but is not classified as an availability code`)
  }
})

test('every staged confinement-planner refusal that can reach the host has local and remote plain-language copy', () => {
  const plannerSource = engineFile('src/lib/agent-session-confinement.js')
  const plannerCodes = new Set(plannerSource.match(/AGENT_CONFINEMENT_[A-Z0-9_]+/g) || [])
  /* These are successful/fail-closed reading statuses, not rejected starts.
     They may ride a successful plan as diagnostic state, while every other
     planner code can be returned as plan.ok=false or raised by the final
     environment assertion the host calls. */
  const statusOnly = new Set([
    'AGENT_CONFINEMENT_RESOLVED',
    'AGENT_CONFINEMENT_RECORD_ABSENT',
    'AGENT_CONFINEMENT_RECORD_UNREADABLE',
    'AGENT_CONFINEMENT_TIER_REFUSED',
    'AGENT_CONFINEMENT_TIER_UNMAPPED',
  ])
  const classified = new Set([...AVAILABILITY_CODES, ...START_REFUSAL_CODES])
  for (const code of plannerCodes) {
    if (statusOnly.has(code)) continue
    assert.ok(classified.has(code), `${code} is raised by the staged planner but is absent from both host refusal vocabularies`)
    assert.ok(Object.hasOwn(UNAVAILABLE_TEXT, code), `${code} would cross agent-start IPC as the generic AGENT_SESSION_FAILED sentence`)
    assert.ok(Object.hasOwn(ENGINE_REASON, code), `${code} has no local home-screen explanation`)
    assert.equal(refusalCode(new Error(code)), code, `${code} does not survive the renderer IPC refusal-code recovery`)

    const desk = startRefusalSentence({ ok: false, code })
    const remote = readerRemedy(desk, { viaRelay: true })
    assert.doesNotMatch(desk, /AGENT_CONFINEMENT_[A-Z0-9_]+/, `${code} is rendered as an identifier instead of plain language`)
    assert.doesNotMatch(remote, /AGENT_CONFINEMENT_[A-Z0-9_]+/, `${code} is rendered remotely as an identifier instead of plain language`)
    assert.doesNotMatch(remote, /\bthis Windows account\b|\bthis computer\b/,
      `${code} gives a relay reader an instruction written for the other computer's desk: ${remote}`)
  }
})

test('account selection failures from the paired engine survive start IPC and every agent surface', () => {
  const require = createRequire(import.meta.url)
  const engineRoot = process.env.MC_CANONICAL_ROOT || join(ROOT, 'capability')
  const { CODE } = require(join(engineRoot, 'src/lib/multi-account/rotation.js'))
  for (const code of [CODE.NONE_USABLE, CODE.EXHAUSTED_MANUAL, CODE.UNREADABLE, CODE.STATE_UNREADABLE,
    'ACCOUNT_RECOVERY_INVALID', 'ACCOUNT_RECOVERY_NO_ALTERNATE', 'ACCOUNT_CLIENT_INVALID', 'AGENT_ACCOUNT_UNAVAILABLE']) {
    assert.ok(START_REFUSAL_CODES.includes(code), `${code} must remain classified as a start refusal`)
    const recovered = refusalCode(new Error(`Error invoking remote method 'mc-agent:start': Error: ${code}`))
    assert.equal(recovered, code)
    const tree = startRefusalSentence({ ok: false, code: recovered })
    const chat = unavailableReason(recovered)
    const home = readAgentEngine({ ok: false, code: recovered })
    assert.equal(home.ready, false)
    for (const sentence of [tree, chat, home.why, readerRemedy(tree, { viaRelay: true })]) {
      assert.match(sentence, /account/i)
      assert.doesNotMatch(sentence, /not told why|not set up to run|ACCOUNT_[A-Z_]+/)
    }
  }
})

test('a broken rules reader refuses host construction after readiness and keeps its repair sentence through IPC', async () => {
  const require = createRequire(import.meta.url)
  for (const fault of ['missing-reader', 'unreadable-registry', 'throws-on-load', 'incomplete-reader', 'older-payload', 'complete-reader']) {
    const root = stagePayload()
    try {
      const registry = join(root, 'config/settings-registry.json')
      mkdirSync(join(root, 'config'), { recursive: true })
      writeFileSync(registry, fault === 'unreadable-registry' ? '{invalid' : JSON.stringify({
        entries: fault === 'older-payload' ? [] : [{ id: 'rules.require_read_each_turn' }],
      }))
      const reader = join(root, 'src/lib/rules-turn-snapshot.js')
      if (fault === 'throws-on-load') writeFileSync(reader, 'throw new Error("fixture rules reader failed")')
      if (fault === 'incomplete-reader') writeFileSync(reader, 'exports.loadRulesReadMode = () => false')
      if (fault === 'complete-reader') writeFileSync(reader, 'module.exports = { loadRulesReadMode() {}, buildRulesTurnSnapshot() {}, assertRulesTurnSnapshotCurrent() {} }')
      const enginePath = join(root, HOST_MODULES.engine)
      const engine = require(enginePath)
      assert.deepEqual(engineAvailability({ enginePath, defaultCwd: root }), { ok: true, code: 'AGENT_ENGINE_READY' },
        'the readiness probe does not load the rules reader; this refusal belongs to construction at start')
      if (fault === 'older-payload' || fault === 'complete-reader') {
        const host = createAgentHost({ enginePath, defaultCwd: root, freeMemory: TEST_FREE_MEMORY })
        await host.closeAll()
      } else {
        let refused
        assert.throws(() => createAgentHost({ enginePath, defaultCwd: root, freeMemory: TEST_FREE_MEMORY }), error => {
          assert.equal(error.code, 'RULES_POLICY_UNAVAILABLE')
          refused = error
          return true
        }, fault)
        const code = refused.code
        assert.ok(START_REFUSAL_CODES.includes(code), 'this construction refusal requires start copy')
        assert.equal(AVAILABILITY_CODES.includes(code), false)
        const recovered = refusalCode(new Error(`Error invoking remote method 'mc-agent:start': Error: ${code}`))
        assert.equal(recovered, code)
        const home = readAgentEngine({ ok: false, code: recovered })
        assert.equal(home.ready, false)
        const tree = startRefusalSentence({ ok: false, code: recovered })
        for (const sentence of [tree, unavailableReason(recovered), home.why,
          unavailableReason(recovered, { subject: AVAILABILITY_SUBJECT_REMOTE }), readerRemedy(tree, { viaRelay: true })]) {
          assert.match(sentence, /rules/i)
          assert.match(sentence, /reinstall|update/i)
          assert.doesNotMatch(sentence, /RULES_|not told why|not set up to run|reset.*data/i)
        }
      }
      assert.deepEqual(engine.calls, [], 'neither readiness nor rules refusal may start a provider')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

test('rules send refusals keep a running session and deliver no message until repaired', async () => {
  const require = createRequire(import.meta.url)
  for (const code of ['RULES_CONTEXT_UNAVAILABLE', 'RULES_POLICY_CHANGED']) {
    const root = stagePayload()
    let host
    try {
      const enginePath = join(root, HOST_MODULES.engine), engine = require(enginePath)
      let repaired = false, reads = 0
      host = createAgentHost({ enginePath, defaultCwd: root, freeMemory: TEST_FREE_MEMORY,
        confinementPlanner: () => ({ ok: true, tier: 'guided', isolated: true,
          threadOptions: { sandbox: 'read-only', approvalPolicy: 'never' }, env: {} }),
        rulesTurnSnapshotLoader: () => ({
          loadRulesReadMode: () => ({ enabled: repaired || code !== 'RULES_POLICY_CHANGED' || ++reads === 1 }),
          buildRulesTurnSnapshot: () => ({ complete: repaired || code !== 'RULES_CONTEXT_UNAVAILABLE', text: 'Fixture complete rules' }),
          assertRulesTurnSnapshotCurrent() {},
        }),
      })
      await host.startSession({ sessionId: 'rules-refusal' })
      assert.equal(engine.calls.length, 1)
      await assert.rejects(host.sendTurn({ sessionId: 'rules-refusal', text: 'Keep this message' }), error => {
        assert.equal(error.code, code)
        return true
      })
      assert.deepEqual(engine.adapterCalls, [], 'an incomplete or changed rules snapshot must never reach the adapter')
      assert.equal(START_REFUSAL_CODES.includes(code), false, 'this refusal describes a message in an existing session')
      assert.equal(AVAILABILITY_CODES.includes(code), false)
      const recovered = refusalCode(new Error(`Error invoking remote method 'mc-agent:send': Error: ${code}`))
      assert.equal(recovered, code)
      const sentence = refusalSentence({ ok: false, code: recovered }, { fallback: 'The message was not accepted by the session.' })
      for (const text of [sentence, readerRemedy(sentence, { viaRelay: true }), unavailableReason(recovered)]) {
        assert.match(text, /rules/i)
        assert.match(text, /send.*again|try again/i)
        assert.doesNotMatch(text, /RULES_|nothing was started|agent.*not started|not told why/i)
      }
      repaired = true
      await host.sendTurn({ sessionId: 'rules-refusal', text: 'Keep this message' })
      assert.equal(engine.calls.length, 1, 'repair retries the existing session rather than starting another')
      assert.equal(engine.adapterCalls.length, 1)
      assert.match(engine.adapterCalls[0].request.text, /^Keep this message/)
      assert.match(engine.adapterCalls[0].request.text, /Fixture complete rules/)
    } finally {
      await host?.closeAll()
      rmSync(root, { recursive: true, force: true })
    }
  }
})

test('recovery and provider refusals survive IPC with actionable local and remote copy', () => {
  for (const code of [
    'AGENT_ACCOUNT_RECOVERY_UNAVAILABLE',
    'AGENT_ACCOUNT_RECOVERY_NO_ALTERNATE',
    'AGENT_CONFINEMENT_PROVIDER_INVALID',
  ]) {
    assert.ok(START_REFUSAL_CODES.includes(code))
    assert.equal(AVAILABILITY_CODES.includes(code), false)
    const recovered = refusalCode(new Error(`Error invoking remote method: Error: ${code}`))
    assert.equal(recovered, code)
    assert.equal(readAgentEngine({ ok: false, code }).ready, false)
    assert.notEqual(readAgentEngine({ ok: false, code }).why, ENGINE_REASON.AGENT_ENGINE_UNAVAILABLE)
    const desk = startRefusalSentence({ ok: false, code: recovered })
    const remote = readerRemedy(desk, { viaRelay: true })
    assert.notEqual(desk, START_REFUSAL.noReasonGiven)
    for (const sentence of [desk, remote]) {
      assert.doesNotMatch(sentence, /AGENT_[A-Z_]+/)
      assert.match(sentence, /Review|Add or sign in|Choose a supported model/)
      assert.doesNotMatch(sentence, /reset.*data|remove.*account/i)
    }
    assert.doesNotMatch(remote, /\bthis Windows account\b|\bthis computer\b/)
  }
})

test('the actual planner refuses an unsupported provider before account preparation and the host starts nothing', async t => {
  const require = createRequire(import.meta.url)
  const planner = require(join(canonicalRootForTests({ requireConfigured: true }), 'src/lib/agent-session-confinement.js'))
  const engine = require('./fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
  let starts = 0
  t.mock.method(engine, 'startCodexSession', () => { starts++; throw new Error('unexpected provider start') })
  for (const provider of [undefined, 'unsupported', { name: 'codex' }]) {
    const plan = planner.preflightSessionPlan({
      provider,
      get account() { throw new Error('account preparation must not be reached') },
    })
    assert.deepEqual(plan, { ok: false, code: 'AGENT_CONFINEMENT_PROVIDER_INVALID' })
    assert.ok(Object.isFrozen(plan))
    const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: COMPLETE_ENGINE, defaultCwd: ROOT, confinementPlanner: () => plan })
    try {
      assert.throws(() => host.startSession({ sessionId: 'refused-provider' }), error => {
        assert.equal(error.code, plan.code)
        assert.equal(refusalCode(new Error(error.code)), plan.code)
        return true
      })
      assert.equal(starts, 0)
      assert.deepEqual(host.sessionAccounts(), [])
    } finally {
      await host.closeAll()
    }
  }
})

test('the recorder half of the vocabulary is derived from what the recorder can raise', () => {
  /* WITHOUT THIS, THE COPY TEST IS SELF-SELECTING. It walks
     RECORD_AVAILABILITY_CODES, so deleting an entry from that list makes the
     copy gap it was covering disappear -- coverage that shrinks to fit is the
     hand-maintained-count defect this repo already names in
     tools/check-suites-discovered.mjs.

     So the list is checked against the source instead: availability() calls
     loadOrCreateKey() and loadHead() and substitutes SPAWN_RECORD_UNAVAILABLE
     for anything without a code, and every SPAWN_RECORD_* those two can raise
     must be in the exported list. */
  const root = testScratch('mc-recorder-availability-')
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(value),
    decryptString: value => value.toString(),
  }
  const observed = new Set()
  const construct = (options, expected) => {
    assert.throws(
      () => createSpawnRecorder(options),
      error => {
        assert.equal(error.code, expected, `recorder construction must report ${expected}`)
        observed.add(error.code)
        return true
      },
    )
  }
  const available = (options, expected) => {
    const result = createSpawnRecorder(options).availability()
    assert.equal(result.ok, false, `${expected} must make the recorder unavailable`)
    assert.equal(result.code, expected, `recorder availability must report ${expected}`)
    observed.add(result.code)
  }

  try {
    construct({ directory: root }, 'SPAWN_RECORD_NO_KEYSTORE')
    construct({ safeStorage }, 'SPAWN_RECORD_NO_DIRECTORY')
    available({ safeStorage: { ...safeStorage, isEncryptionAvailable: () => false }, directory: join(root, 'keystore-off') }, 'SPAWN_RECORD_KEYSTORE_UNAVAILABLE')

    const unreadable = join(root, 'unreadable')
    mkdirSync(unreadable)
    writeFileSync(join(unreadable, 'agent-spawn-key.enc'), 'not a key')
    available({ safeStorage: { ...safeStorage, decryptString: () => { throw new Error('cannot decrypt') } }, directory: unreadable }, 'SPAWN_RECORD_KEY_UNREADABLE')

    const corrupt = join(root, 'corrupt')
    const recorder = createSpawnRecorder({ safeStorage, directory: corrupt })
    assert.equal(recorder.availability().ok, true, 'the corrupt-ledger fixture must first create a usable signing key')
    writeFileSync(recorder.ledgerPath, '{not json}\n')
    available({ safeStorage, directory: corrupt }, 'SPAWN_RECORD_LEDGER_CORRUPT')

    available({
      safeStorage: { ...safeStorage, isEncryptionAvailable: () => { throw new Error('keystore probe failed') } },
      directory: join(root, 'unexpected'),
    }, 'SPAWN_RECORD_UNAVAILABLE')

    assert.deepEqual(
      new Set(RECORD_AVAILABILITY_CODES),
      observed,
      'the exported recorder availability vocabulary must equal the failures callers can observe',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* THE THIRD DEV-ONLY-WORKS BUG on this path, and the last one blocking
   "start an agent from inside ToolsEnabled".

   getAgentHost() passed `path.join(__dirname, '..')` as the session cwd. In a
   checkout that is the repo root; in a packaged app `__dirname` lives inside
   the archive, so it resolved to `resources/app.asar` -- a FILE. Electron's
   asar-patched fs reports that path as a directory, so normalizeCwd() approved
   it, and child_process.spawn (which does not honour the patch) then failed at
   CreateProcess with an ENOENT blamed on the command. Every packaged agent
   start died there while every checkout stayed green.

   MEASURED 2026-08-10 with the shipped binary as the engine's script host:
     cwd = <a real directory>      -> START OK, threadId issued
     cwd = ...\resources\app.asar  -> CODEX_APP_SERVER_EXITED, spawn ... ENOENT
   Same binary, same engine, same auth; the cwd was the only difference. */

test('the agent session cwd is a real directory, not a path inside the app bundle', () => {
  // The defect in one line. A __dirname-relative default is a real directory in
  // a checkout and a virtual one inside the asar, so this can only be caught by
  // reading what the shell actually passes.
  const main = read('shell/main.cjs')
  const call = main.match(/createAgentHost\(\{[^}]*\}\)/)
  assert.ok(call, 'main.cjs must construct the agent host with an explicit default cwd')
  assert.doesNotMatch(
    call[0],
    /__dirname/,
    'the agent default cwd must not be derived from __dirname: inside a packaged app that is an asar path, which cannot be a spawn working directory',
  )
  assert.match(call[0], /defaultCwd:\s*WORKSPACE_ROOT/, 'the agent must run in the workspace root')
  assert.match(
    main,
    /const WORKSPACE_ROOT = path\.join\(app\.getPath\('userData'\), 'workspace'\)/,
    'the workspace root must be a real directory under userData',
  )
})

test('a cwd inside an asar archive is refused with a message that says so', () => {
  // The validator must reject what the spawn will reject. Named explicitly
  // because "not a directory" about a path Electron's own fs calls a directory
  // reads as a contradiction, and that confusion is what cost the time.
  const root = testScratch('mc-agent-cwd-')
  try {
    const archive = join(root, 'resources', 'app.asar')
    mkdirSync(join(root, 'resources'), { recursive: true })
    writeFileSync(archive, 'not a directory')
    assert.throws(
      () => createAgentHost({ freeMemory: TEST_FREE_MEMORY,
        enginePath: COMPLETE_ENGINE,
        defaultCwd: archive,
      }),
      (error) => {
        assert.equal(error.code, 'AGENT_HOST_INVALID_CWD')
        assert.match(error.message, /inside an asar archive/)
        return true
      },
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the cwd check asks the question the spawn will ask, not the one fs answers', () => {
  // Under Electron, a plain fs.statSync() reports asar-internal paths as
  // directories, so the isDirectory() guard above passes on exactly the path
  // that broke. `process.noAsar` makes validation and execution agree. This is
  // asserted on the source because the divergence only exists inside Electron
  // and cannot be reproduced by the plain-node test runner.
  const agentHost = read('shell/agent-host.cjs')
  assert.match(agentHost, /process\.noAsar = true/, 'the cwd stat must run with asar interception disabled')
  assert.match(
    agentHost,
    /statAsTheOsWill\(resolved\)/,
    'normalizeCwd must use the unpatched stat, not fs.statSync directly',
  )
  assert.doesNotMatch(
    agentHost.slice(agentHost.indexOf('function normalizeCwd')),
    /fs\.statSync/,
    'normalizeCwd must not fall back to the asar-patched stat',
  )
})

test('an explicitly configured engine still wins over the shipped payload', () => {
  // A developer pointing MISSION_CONTROL_ENGINE at their own checkout must keep
  // getting that checkout, not the packaged copy -- the same precedence
  // shell/main.cjs applies to MC_BRIDGE_PROOF_FILE. Pinned because the obvious
  // way to add the payload candidate is to put it first, which would silently
  // start ignoring the override.
  //
  // Asserted on the CANDIDATE ORDER, not on engineAvailability(). The resolver
  // walks every candidate and returns the first that WORKS, so when only one of
  // them resolves the order is invisible through availability() -- an earlier
  // version of this test did exactly that and stayed GREEN when the precedence
  // was deliberately reversed. Proven by planting that swap.
  const previous = process.env.MISSION_CONTROL_ENGINE
  process.env.MISSION_CONTROL_ENGINE = resolve(ROOT, 'tools/test/fixtures/agent-engine')
  try {
    const sources = engineCandidates(undefined, { capabilityRoot: '/any/payload/root' }).map((c) => c.source)
    assert.deepEqual(
      sources,
      ['MISSION_CONTROL_ENGINE', 'capability-payload'],
      'the configured engine must be tried before the shipped payload',
    )
  } finally {
    if (previous === undefined) delete process.env.MISSION_CONTROL_ENGINE
    else process.env.MISSION_CONTROL_ENGINE = previous
  }
})


test('specific saved-account resume refusals survive IPC and retain actionable start copy', () => {
  for (const code of ['AGENT_RESUME_ACCOUNT_LIMIT', 'AGENT_RESUME_ACCOUNT_SIGNED_OUT']) {
    assert.equal(refusalCode(new Error(code)), code)
    assert.ok(Object.hasOwn(UNAVAILABLE_TEXT, code))
    const sentence = startRefusalSentence({ ok: false, code })
    assert.notEqual(sentence, START_REFUSAL.noReasonGiven)
    assert.match(sentence, /Accounts|another account/)
  }
})
