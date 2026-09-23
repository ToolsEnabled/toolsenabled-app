/* Production host proof for configured role execution.
 *
 * The org-record and command-surface suites prove who may supply the role
 * object. This suite starts the real host against the existing confined-engine
 * fixture and asserts what its adapter receives: stored directions on the first
 * turn, never on the second, for both a custom id and the shadow-manager id.
 * Supplying edited shadow-manager words is intentional: if the host contains a
 * name-based definition or mechanic, this test observes the wrong words. */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { testScratchRoot } from '../lib/test-scratch-root.mjs'

/* THIS SUITE IS NOT ABOUT THE MEMORY ADMISSION RULE. Left unset, createAgentHost
   defaults freeMemory to the real os.freemem() (shell/agent-host.cjs:2559), which
   startSession consults at :3870 and refuses at :3873. Every start below would then
   fail with AGENT_MEMORY_LOW whenever this computer happens to be short of memory,
   so the suite's colour would track the machine rather than the code under test.
   memoryAdmission() keeps its own coverage in agent-memory-admission.test.mjs, and
   agent-resource-wiring.test.mjs drives it deliberately with freeMemory: () => 0. */
const TEST_FREE_MEMORY = () => 64 * 1024 * 1024 * 1024

const require_ = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const { createAgentHost } = require_(path.join(ROOT, 'shell/agent-host.cjs'))
const ENGINE = path.join(ROOT, 'tools/test/fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
const STREAMING_ENGINE = path.join(ROOT, 'tools/test/fixtures/streaming-engine/src/lib/agent-engine/codex-process.js')
const SCRATCH = testScratchRoot('.toolsenabled-role-directions-test')
mkdirSync(SCRATCH, { recursive: true })
test.after(() => rmSync(SCRATCH, { recursive: true, force: true }))

const role = (id, over = {}) => ({
  id,
  name: id === 'release-scribe' ? 'Release scribe' : 'Shadow manager',
  summary: null,
  owns: 'Record the evidence named in this task.',
  mustNot: 'Change the inputs or accept the result.',
  handoff: 'Return measured evidence to the dispatcher.',
  rules: [],
  revision: 1,
  ...over,
})

function plan(workdir) {
  return {
    ok: true,
    tier: 'guided',
    isolated: true,
    threadOptions: { sandbox: 'read-only', approvalPolicy: 'never' },
    env: { CODEX_HOME: path.join(workdir, 'agent-home') },
    servers: [],
  }
}

function calls() {
  return require_(ENGINE).adapterCalls
}

async function completeTurn() {
  const startCall = require_(ENGINE).calls.at(-1)
  startCall.onEvent({ type: 'turn_completed', threadId: 'thread-1', turnId: 't1', status: 'completed' })
}

test('a custom role reaches the first turn visibly and exactly once', async () => {
  const workdir = mkdtempSync(path.join(SCRATCH, 'custom-'))
  try {
    const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: ENGINE, defaultCwd: workdir, confinementPlanner: () => plan(workdir) })
    const started = await host.startSession({ sessionId: 'custom-role', role: role('release-scribe') })
    assert.match(started.roleIntroduction, /Role: Release scribe/)
    assert.match(started.roleIntroduction, /Record the evidence named in this task/)
    assert.match(started.roleIntroduction, /do not grant tools, permissions, or authority/i)

    const before = calls().length
    const accepted = await host.sendTurn({ sessionId: 'custom-role', text: 'Inspect the release record.' })
    const first = calls()[before].request.text
    assert.ok(first.startsWith('Inspect the release record.'), 'the person\'s task must remain first')
    assert.ok(first.endsWith(started.roleIntroduction), 'the visible role block and the block sent to the adapter differ')
    assert.equal([accepted.transcriptPrompt.text, ...accepted.transcriptPrompt.additions.map(part => part.text)].join('\n\n'), first, 'canonical capture must receive the exact accepted provider prompt')
    assert.equal(accepted.transcriptPrompt.additions.find(part => part.kind === 'role').text, started.roleIntroduction)

    await completeTurn()
    const next = await host.sendTurn({ sessionId: 'custom-role', text: 'Report the next item.' })
    assert.deepEqual(next.transcriptPrompt.additions, [], 'spent role directions must not be replayed into saved history')
    assert.equal(calls()[before + 1].request.text, 'Report the next item.', 'role directions replayed after onboarding')
    await host.closeAll()
  } finally {
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('shadow-manager uses the same formatter and the supplied stored directions', async () => {
  const workdir = mkdtempSync(path.join(SCRATCH, 'shadow-'))
  try {
    const stored = role('shadow-manager', {
      owns: 'Use the edited ordinary role sheet, not a built-in shadow behavior.',
      mustNot: 'Gain special authority from this role name.',
      handoff: 'Return the observation to the person who asked.',
      revision: 8,
    })
    const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: ENGINE, defaultCwd: workdir, confinementPlanner: () => plan(workdir) })
    await host.startSession({ sessionId: 'shadow-role', role: stored })
    const before = calls().length
    await host.sendTurn({ sessionId: 'shadow-role', text: 'Check the ordinary role binding.' })
    const sent = calls()[before].request.text
    assert.match(sent, /Use the edited ordinary role sheet/)
    assert.match(sent, /Gain special authority from this role name/)
    assert.doesNotMatch(sent, /silently repair a finding|become a second controller/,
      'the host substituted a name-based shipped shadow-manager definition')
    await host.closeAll()
  } finally {
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('a named agent uses the exact server-issued credential while anonymous in-process mode carries no authority', async () => {
  for (const bound of [true, false]) {
    const workdir = mkdtempSync(path.join(SCRATCH, bound ? 'authority-owner-' : 'authority-local-'))
    const issued = Buffer.alloc(32, bound ? 0x31 : 0x72).toString('base64url')
    const plans = []
    const bindings = []
    const revocations = []
    const beforeCalls = require_(ENGINE).calls.length
    try {
      const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY,
        enginePath: ENGINE,
        defaultCwd: workdir,
        confinementPlanner(options) {
          plans.push({ ...options })
          return {
            ...plan(workdir),
            env: {
              CODEX_HOME: path.join(workdir, 'agent-home'),
              ...(options.sessionCredential
                ? { TOOLSENABLED_AGENT_SESSION_CREDENTIAL: options.sessionCredential }
                : {}),
            },
          }
        },
        sessionAuthority: {
          async bind(binding) {
            bindings.push({ ...binding })
            return {
              bound,
              mode: bound ? 'owner-host' : 'in-process',
              credential: bound ? issued : null,
            }
          },
          async revoke(binding) {
            revocations.push({ ...binding })
            return { revoked: true }
          },
        },
      })
      await host.startSession(bound ? {
        sessionId: 'authority-owner',
        role: role('release-scribe'),
        agentId: 'agent-alpha',
        agentAuthority: {
          agentId: 'agent-alpha',
          provider: 'codex',
          roleId: 'release-scribe',
          expectedOrgRevision: 19,
          expectedRoleRevision: 1,
        },
      } : {
        sessionId: 'authority-local',
        role: role('release-scribe'),
      })

      assert.equal(bindings.length, 1)
      assert.equal(Object.hasOwn(bindings[0], 'credential'), false,
        'the trusted launcher, rather than the owner host, chose the credential')
      assert.deepEqual(bindings[0], {
        sessionId: `authority-${bound ? 'owner' : 'local'}`,
        agentId: bound ? 'agent-alpha' : null,
        provider: 'codex',
        roleId: bound ? 'release-scribe' : null,
        expectedOrgRevision: bound ? 19 : null,
        expectedRoleRevision: bound ? 1 : null,
      })
      assert.equal(plans.length, bound ? 2 : 1,
        'the confinement plan count did not match the authenticated transport mode')
      assert.equal(plans[0].sessionCredential, null)
      if (bound) {
        assert.equal(plans[1].sessionCredential, issued)
        assert.equal(require_(ENGINE).calls[beforeCalls].env.TOOLSENABLED_AGENT_SESSION_CREDENTIAL, issued,
          'the child environment did not carry the exact credential returned by the binding authority')
      } else {
        assert.equal(Object.hasOwn(require_(ENGINE).calls[beforeCalls].env, 'TOOLSENABLED_AGENT_SESSION_CREDENTIAL'), false,
          'an anonymous in-process session carried an unresolvable authority credential')
      }

      await host.closeAll()
      assert.equal(revocations.length, bound ? 1 : 0)
      if (bound) {
        assert.equal(revocations[0].credential, issued,
          'close revoked a credential other than the exact byte string exposed to the child')
      }
    } finally {
      rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
    }
  }
})

test('a definite pre-accept refusal retains role directions for one retry, but an announced turn never replays them', async () => {
  const engine = require_(STREAMING_ENGINE)
  engine.reset()
  const workdir = mkdtempSync(path.join(SCRATCH, 'retry-'))
  try {
    const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: STREAMING_ENGINE, defaultCwd: workdir, confinementPlanner: () => plan(workdir) })
    const prompts = []
    host.onAcceptedPrompt(prompt => prompts.push(prompt))
    host.onEvent(packet => {
      if (packet.event?.type === 'assistant_text_delta') assert.ok(prompts.some(prompt => prompt.turnId === packet.event.turnId), 'accepted input must be captured before its first speech event')
    })
    const started = await host.startSession({ sessionId: 'retry-role', role: role('release-scribe') })

    const refused = host.sendTurn({ sessionId: 'retry-role', text: 'Try the bound task.' })
    await new Promise(resolve => setTimeout(resolve, 0))
    const refusal = Object.assign(new Error('not accepted'), { code: 'FAKE_PRE_ACCEPT_REFUSAL' })
    engine.control.rejectTurn(refusal)
    await assert.rejects(refused, error => error === refusal)
    assert.deepEqual(prompts, [], 'a definite pre-accept refusal must not be recorded as sent')
    assert.ok(engine.control.requests[0].text.endsWith(started.roleIntroduction))

    const accepted = host.sendTurn({ sessionId: 'retry-role', text: 'Retry the bound task.' })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.ok(engine.control.requests[1].text.endsWith(started.roleIntroduction),
      'the retry ran without the role directions that the engine never accepted')
    engine.narrate({ type: 'assistant_text_delta', threadId: 'thread-1', turnId: 'accepted-turn', text: 'working' })
    await accepted
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0].transcriptPrompt.additions.find(part => part.kind === 'role').text, started.roleIntroduction)
    engine.control.rejectTurn(Object.assign(new Error('failed after announce'), { code: 'FAKE_POST_ACCEPT_FAILURE' }))
    await new Promise(resolve => setTimeout(resolve, 0))

    const later = host.sendTurn({ sessionId: 'retry-role', text: 'Continue after the accepted turn.' })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(engine.control.requests[2].text, 'Continue after the accepted turn.',
      'an announced role introduction replayed onto a later turn')
    engine.narrate({ type: 'assistant_text_delta', threadId: 'thread-1', turnId: 'later-turn', text: 'continuing' })
    await later
    assert.equal(prompts.length, 2)
    assert.deepEqual(prompts[1].transcriptPrompt.additions, [])
    await host.closeAll()
  } finally {
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('long multiline role context reaches the first real adapter turn without losing Unicode or paragraphs', async () => {
  const workdir = mkdtempSync(path.join(SCRATCH, 'context-'))
  const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: ENGINE, defaultCwd: workdir, confinementPlanner: () => plan(workdir) })
  try {
    const context = 'Start here:\n\n' + '任务上下文。'.repeat(900) + '\nReturn the exact evidence.'
    const configured = role('release-scribe', { owns: context, handoff: 'Read the supplied assignment.\n\nReport to its dispatcher.' })
    await host.startSession({ sessionId: 'context-role', role: configured })
    const before = calls().length
    await host.sendTurn({ sessionId: 'context-role', text: 'Complete the assigned task.' })
    assert.ok(calls()[before].request.text.includes(context), 'The adapter must receive the full supplied context, including paragraph boundaries')
    assert.throws(() => host.startSession({ sessionId: 'too-long', role: role('release-scribe', { owns: 'x'.repeat(6001) }) }))
    assert.throws(() => host.startSession({ sessionId: 'control-character', role: role('release-scribe', { owns: 'Text\u0000with a control' }) }))
  } finally {
    await host.closeAll()
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('an assigned custom role accepts empty directions without inventing prose or erasing function and action policy', async t => {
  const workdir = mkdtempSync(path.join(SCRATCH, 'empty-text-'))
  const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: ENGINE, defaultCwd: workdir, confinementPlanner: () => plan(workdir) })
  t.after(() => host.closeAll())
  const stored = role('empty-helper', { name: 'empty-helper', owns: '', mustNot: '', handoff: '',
    functions: ['app.context'], requiresDirectUserAuthorization: true })
  const started = await host.startSession({ sessionId: 'empty-text', role: stored })
  assert.match(started.roleIntroduction, /Role: empty-helper/)
  assert.match(started.roleIntroduction, /Selected functions \(1\): app.context/)
  assert.match(started.roleIntroduction, /act only on a direct request from the person/)
  assert.doesNotMatch(started.roleIntroduction, /Owns:|Must not:|Hands off to:|Worker|Not written yet/)
  const before = calls().length
  const first = await host.sendTurn({ sessionId: 'empty-text', text: 'Keep the requested task.' })
  assert.ok(calls()[before].request.text.endsWith(started.roleIntroduction))
  assert.equal(first.transcriptPrompt.additions.find(part => part.kind === 'role').text, started.roleIntroduction)
  await completeTurn()
  const later = await host.sendTurn({ sessionId: 'empty-text', text: 'Continue that task.' })
  assert.deepEqual(later.transcriptPrompt.additions, [])
  assert.equal(calls()[before + 1].request.text, 'Continue that task.')
})

test('allowing empty instruction strings retains formatter type, control, length and role identity checks', () => {
  const { composeRoleIntroduction } = require_(path.join(ROOT, 'shell/agent-host.cjs'))
  const empty = role('empty-helper', { owns: '', mustNot: '', handoff: '' })
  for (const field of ['owns', 'mustNot', 'handoff']) for (const value of [undefined, null, false, [], {}, '\u0000', 'x'.repeat(6001)]) {
    assert.throws(() => composeRoleIntroduction({ ...empty, [field]: value }))
  }
  for (const change of [{ id: '' }, { name: '' }, { rules: [''] }, { rules: 'directions' }]) {
    assert.throws(() => composeRoleIntroduction({ ...empty, ...change }))
  }
})
