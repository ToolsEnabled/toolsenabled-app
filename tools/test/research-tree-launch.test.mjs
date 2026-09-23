import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'
import { bindResearchTreeSession, withResearchTreeBinding } from '../../src/research-tree-session.js'
import { refusalCode } from '../../src/agent-availability-copy.js'
import { refusalCodeOf } from '../../src/refusal-copy.js'

// Execute the complete exported launch declarations from the actual view.
// Remove only their module export keyword for the same source extraction seam
// used by tree-start-cleanup-retention.test.mjs. Browser presentation and native
// IPC are the fixture; the launch flow, retained identity and binder are real.
const source = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
  .replace(/^export (?=(?:async )?function )/gm, '')
const declarations = ['withRetainedStartIdentity', 'endedAgentStartOutcome', 'startAgentForNode']
  .map(name => declaredFunctionSource(source, name)).join('\n')
const projectId = 'rp-0123456789abcdef'
const project = { projectId, name: 'Authoritative research title', status: 'active', enabled: false }
const deferred = () => {
  let resolve
  const promise = new Promise(answer => { resolve = answer })
  return { promise, resolve }
}

function fixture({ missingProject = false, assignGate = null, closeFails = false } = {}) {
  const calls = { starts: [], sends: [], closes: [], assigned: [], opened: [], cleanup: [], order: [] }
  const assignmentEntered = deferred()
  const native = {
    async start(request) {
      calls.starts.push(request); calls.order.push('native.start')
      return { sessionId: request.sessionId, threadId: 'provider-thread', roleIntroduction: 'Configured role' }
    },
    async send(request) {
      calls.sends.push(request); calls.order.push('native.send')
      return { sessionId: request.sessionId, turnId: 'accepted-turn' }
    },
    async close(request) {
      calls.closes.push(request); calls.order.push('native.close')
      if (closeFails) throw new Error('Close refused')
      return { sessionId: request.sessionId, closed: true }
    },
  }
  const bind = args => bindResearchTreeSession({
    ...args, requireDestination: false,
    snapshot: async () => {
      calls.order.push('research.snapshot')
      return { ok: true, receipt: { projects: missingProject ? [] : [project] } }
    },
    postAction: async (action, body) => {
      calls.assigned.push({ action, body }); calls.order.push('research.assign')
      assignmentEntered.resolve()
      if (assignGate) await assignGate.promise
      calls.order.push('research.receipt')
      return { ok: true, receipt: { projectId, assigned: [{
        assignmentId: 'ra-abcdef0123456789', disposition: 'assigned',
        kind: 'observed', ref: body.assign[0].ref,
      }], unassigned: [] } }
    },
  })
  const scope = {
    window: { mcAgent: native },
    withResearchTreeBinding: (bridge, options = {}) => withResearchTreeBinding(bridge, { ...options, bind, requireDestination: false }),
    currentDataSource: () => 'local', isWriteEnabled: () => true,
    START_CONTROL_FLAG: 'agent-session', START_NEEDS_APP_TEXT: () => 'Needs app',
    exampleBoardText: () => 'Example', startControlOffReason: () => 'Starting is off',
    refusalCode, refusalCodeOf,
    readerRemedy: sentence => sentence,
    startRefusalSentence: result => result?.reason || result?.code || 'Start refused',
    sendRefusalSentence: result => result?.reason || result?.code || 'Send refused',
    refusalNeedsAssistantProgram: () => false,
    TERMINAL_AGENT_SESSION_CODES: new Set(['MC_AGENT_UNKNOWN_SESSION', 'MC_AGENT_SESSION_ENDED']),
  }
  const launch = new Function(...Object.keys(scope), declarations
    + '\nreturn { startAgentForNode, withRetainedStartIdentity }')(...Object.values(scope))
  const start = (extra = {}) => launch.startAgentForNode({
    text: 'Review the project findings.', surface: 'fleet-tree', researchProjectId: projectId,
    onSessionOpen: value => { calls.opened.push(value); calls.order.push('onSessionOpen') },
    onCleanupRequired: value => calls.cleanup.push(value),
    ...extra,
  })
  return { calls, native, start, launch, assignmentEntered }
}

test('actual tree launch confirms service membership before publish/send and strips renderer-only IPC fields', async () => {
  const gate = deferred()
  const f = fixture({ assignGate: gate })
  let settled = false
  const pending = f.start({ researchProjectName: 'Stale browser title' }).then(result => { settled = true; return result })
  await f.assignmentEntered.promise
  assert.equal(settled, false)
  assert.equal(f.calls.opened.length, 0)
  assert.equal(f.calls.sends.length, 0)
  assert.equal(Object.hasOwn(f.calls.starts[0], 'researchProjectId'), false)
  assert.equal(Object.hasOwn(f.calls.starts[0], 'researchProjectName'), false)
  const actualId = f.calls.starts[0].sessionId
  assert.deepEqual(f.calls.assigned, [{
    action: 'research-session-assign',
    body: { projectId, assign: [{ kind: 'observed', ref: actualId }] },
  }])
  gate.resolve()
  const result = await pending
  assert.equal(result.ok, true)
  assert.equal(result.sessionId, actualId)
  assert.deepEqual(f.calls.order, [
    'native.start', 'research.snapshot', 'research.assign', 'research.receipt', 'onSessionOpen', 'native.send',
  ])
  assert.ok(f.calls.opened[0].roleIntroduction.includes(project.name))
  assert.ok(f.calls.sends[0].text.startsWith('Review the project findings.\n\n'))
  assert.ok(f.calls.sends[0].text.includes(project.name))
  assert.equal(f.calls.sends[0].text.includes('Stale browser title'), false)
  assert.ok(f.calls.sends[0].text.includes(JSON.stringify({ refs: [{ kind: 'observed', ref: actualId }] })))
})

test('actual tree launch closes a session after failed binding and never publishes or sends', async () => {
  const f = fixture({ missingProject: true })
  const result = await f.start()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'RESEARCH_PROJECT_NOT_FOUND')
  assert.equal(result.sessionId, null)
  assert.deepEqual(f.calls.closes, [{ sessionId: f.calls.starts[0].sessionId }])
  assert.equal(f.calls.opened.length, 0)
  assert.equal(f.calls.sends.length, 0)
  assert.equal(f.calls.assigned.length, 0)
})

test('actual retained-start identity keeps the real Stop target when binding cleanup fails', async () => {
  const f = fixture({ missingProject: true, closeFails: true })
  const result = await f.start()
  const actualId = f.calls.starts[0].sessionId
  assert.equal(result.ok, false)
  assert.equal(result.code, 'AGENT_SESSION_CLEANUP_FAILED')
  assert.equal(result.sessionId, actualId)
  assert.equal(result.cleanupPending, true)
  assert.deepEqual(f.calls.cleanup, [{ sessionId: actualId, code: 'AGENT_SESSION_CLEANUP_FAILED' }])
  assert.equal(f.calls.opened.length, 0)
  assert.equal(f.calls.sends.length, 0)
})

test('actual retained native resume passes its thread and shares project context with the later send wrapper', async () => {
  const f = fixture()
  const retained = f.launch.withRetainedStartIdentity(f.native)
  const result = await retained.start({ resumeThreadId: 'saved-provider-thread', researchProjectId: projectId })
  assert.equal(f.calls.starts[0].resumeThreadId, 'saved-provider-thread')
  assert.equal(Object.hasOwn(f.calls.starts[0], 'researchProjectId'), false)
  assert.ok(result.roleIntroduction.includes(project.name))
  assert.equal(f.calls.sends.length, 0)
  await withResearchTreeBinding(f.native).send({ sessionId: result.sessionId, text: 'Continue the research.' })
  assert.ok(f.calls.sends[0].text.includes(project.name))
  assert.ok(f.calls.sends[0].text.includes(result.sessionId))
})

test('direct research setup marker is forwarded only when supplied and invalid values are not hidden', async () => {
  const f = fixture()
  await f.start({ researchProjectId: null, text: 'Clean-room setup', researchSetup: true })
  await f.start({ researchProjectId: null, text: 'Invalid setup marker', researchSetup: 'unexpected' })
  await f.start({ researchProjectId: null, text: 'Ordinary task' })
  assert.equal(f.calls.starts[0].researchSetup, true)
  assert.equal(f.calls.starts[1].researchSetup, 'unexpected')
  assert.equal(Object.hasOwn(f.calls.starts[2], 'researchSetup'), false)
})

test('actual ordinary tree launch uses its unchanged native path without research service reads or writes', async () => {
  const f = fixture()
  const result = await f.start({ researchProjectId: null, text: 'Ordinary task' })
  assert.equal(result.ok, true)
  assert.deepEqual(f.calls.order, ['native.start', 'onSessionOpen', 'native.send'])
  assert.equal(f.calls.assigned.length, 0)
  assert.equal(f.calls.sends[0].text, 'Ordinary task')
  assert.equal(f.calls.opened[0].roleIntroduction, 'Configured role')
})
