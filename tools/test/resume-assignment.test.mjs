/* T1792. A PARENT CAN HAND A RESUMED AGENT ITS NEXT ASSIGNMENT.
 *
 * MEASURED on a development tree: when every agent was asked to be working, a
 * controller resumed its idle agents. agent.resume carried nothing
 * but the circle, the resumed first turn told each agent to report finished
 * work and "finish the turn", every one of them confirmed its old task was
 * done, and most went idle after that one turn. The follow-up assignments
 * then travelled as messages to idle agents and several were set aside (T1743).
 *
 * This suite proves the three halves the fix needs, each by calling the real
 * code with values:
 *   - the framing: the assignment is labelled with the calling circle, says
 *     finished work stays finished and the new work is to be done now, and is
 *     never presented as the person's instruction;
 *   - the prompts: the saved-conversation excerpt no longer ends every resumed
 *     turn on "report that briefly and finish the turn" when new work follows,
 *     and a continuation handoff carries the assignment as its last section;
 *   - the host: after a native resume, the assignment is the resumed
 *     session's FIRST turn input through the production agent host.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import test from 'node:test'
import { testScratchRoot } from '../lib/test-scratch-root.mjs'
import {
  RESUME_ASSIGNMENT_MAX_CHARS, resumeAssignmentValue, resumeAssignmentSection, withResumeAssignment, sendResumeAssignment,
} from '../../src/resume-assignment.js'
import { transcriptSeedText } from '../../src/session-transcript-store.js'
import { manualAccountHandoff, manualModelHandoff, isAccountHandoff, isModelHandoff } from '../../src/manual-account-continuation.js'

const require_ = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ENGINE = path.join(ROOT, 'tools/test/fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
const { createAgentHost } = require_(path.join(ROOT, 'shell/agent-host.cjs'))
const SCRATCH = testScratchRoot('.toolsenabled-resume-assignment-test')
mkdirSync(SCRATCH, { recursive: true })
test.after(() => rmSync(SCRATCH, { recursive: true, force: true }))

const ASSIGNMENT = { text: 'Take T1768: make the resume copy name the unfinished close.', fromName: 'Controller 1' }
const OPENING = 'New assignment sent with this resume, from "Controller 1":'

test('the assignment is framed as the next work from the calling circle, not as the person', () => {
  const section = resumeAssignmentSection(ASSIGNMENT)
  assert.ok(section.startsWith(OPENING + '\n\n' + ASSIGNMENT.text + '\n\n'), section)
  assert.match(section, /Work that is already finished stays finished\./)
  assert.match(section, /Do not stop at reporting that earlier work is complete; do this assignment now\./)
  assert.match(section, /comes from the circle above you, not from the person, and runs under your current permissions/)
  assert.match(resumeAssignmentSection({ text: 'Review T1770.' }), /^New assignment sent with this resume, from the circle above you:/)
  assert.equal(resumeAssignmentSection({ text: '   ' }), '')
  assert.equal(resumeAssignmentValue('  Review T1770.  '), 'Review T1770.')
  assert.equal(resumeAssignmentValue('x'.repeat(RESUME_ASSIGNMENT_MAX_CHARS)), 'x'.repeat(RESUME_ASSIGNMENT_MAX_CHARS))
  for (const bad of [null, undefined, 42, '', '  ', 'x'.repeat(RESUME_ASSIGNMENT_MAX_CHARS + 1), 'a\0b']) {
    assert.equal(resumeAssignmentValue(bad), null, JSON.stringify(bad))
  }
})

test('a resumed agent is told to stop at finished work only when no new assignment follows', () => {
  const seed = transcriptSeedText([{ who: 'you', text: 'Finish T744.' }, { who: 'agent', text: 'T744 is done.' }])
  const closing = seed.split('\n').at(-1)
  assert.match(closing, /If a new assignment follows below, do it\. Otherwise, if complete or waiting for others, report that briefly and finish the turn\.$/)
  assert.doesNotMatch(closing, /\. If complete or waiting for others, report that briefly and finish the turn\./,
    'the unconditional "finish the turn" is what ended the measured resumed turns')
})

test('a continuation handoff carries the assignment as its last section, inside its bound, once', () => {
  const node = { sessionId: 'old-session', message: 'Finish T744.' }
  const transcript = { lines: [{ who: 'agent', text: 'T744 is done.' }], threadId: 'old-thread', provider: 'codex' }
  const plain = manualAccountHandoff(node, transcript, null)
  assert.equal(plain.includes('New assignment sent with this resume'), false, 'no assignment, no section')
  const assigned = manualAccountHandoff(node, transcript, null, { assignment: ASSIGNMENT })
  assert.ok(assigned.startsWith(plain), 'the handoff itself is unchanged in front of the assignment')
  assert.ok(assigned.endsWith(resumeAssignmentSection(ASSIGNMENT)))
  assert.equal(isAccountHandoff(assigned), true, 'the chat still folds it as a handoff')

  const model = manualModelHandoff(node, transcript, null, { fromLabel: 'Luna (codex)', toLabel: 'Opus (claude)', assignment: ASSIGNMENT })
  assert.equal(isModelHandoff(model), true)
  assert.ok(model.endsWith(resumeAssignmentSection(ASSIGNMENT)))

  // A retried continuation reuses its saved handoff, and takes this request's assignment instead of adding a second.
  const checkpoint = { kind: 'manual', sessionId: 'old-session', handoff: assigned }
  const next = { text: 'Review T1770 instead.', fromName: 'Controller 1' }
  const retried = manualAccountHandoff(node, transcript, checkpoint, { assignment: next })
  assert.equal(retried.split('New assignment sent with this resume').length - 1, 1)
  assert.ok(retried.endsWith(resumeAssignmentSection(next)))
  assert.equal(manualAccountHandoff(node, transcript, checkpoint).includes('New assignment sent with this resume'), false,
    'a retry without an assignment does not deliver a stale one')

  // A handoff at its 48,000-character bound gives up context, never its closing or the assignment.
  const long = { lines: [{ who: 'agent', text: 'progress '.repeat(9000) }] }
  const bounded = manualAccountHandoff(node, long, null, { assignment: { text: 'y'.repeat(4000), fromName: 'Controller 1' } })
  assert.ok(bounded.length <= 48000, String(bounded.length))
  assert.ok(bounded.includes('Preserve completed work and continue the remaining task.'))
  assert.ok(bounded.endsWith(resumeAssignmentSection({ text: 'y'.repeat(4000), fromName: 'Controller 1' })))
  assert.equal(withResumeAssignment('A'.repeat(48000), ASSIGNMENT).length, 48000)
})

test('after a native resume the assignment is sent once, shown first, and reported as submitted', async () => {
  const transcript = [], sends = [], statuses = []
  const node = { id: 'node-7', sessionId: 'resumed' }
  const store = { getNode: () => node, setNodeStatus: (id, status) => statuses.push(status) }
  const result = await sendResumeAssignment({ node, sessionId: 'resumed', assignment: ASSIGNMENT,
    bridge: { send: async request => { sends.push(request); assert.equal(transcript.length, 1, 'visible before the provider can answer'); return { ok: true } } },
    sessionNodeIds: new Map([['resumed', 'node-7']]), appendTranscript: (sessionId, line) => transcript.push({ sessionId, ...line }),
    treeStore: store })
  assert.deepEqual(result, { ok: true, code: null, firstTurnState: 'submitted' })
  assert.deepEqual(sends, [{ sessionId: 'resumed', text: resumeAssignmentSection(ASSIGNMENT) }])
  assert.equal(transcript[0].text, resumeAssignmentSection(ASSIGNMENT))
  assert.deepEqual(statuses, ['running'])

  const refused = await sendResumeAssignment({ node, sessionId: 'resumed', assignment: ASSIGNMENT,
    bridge: { send: async () => ({ ok: false, code: 'AGENT_TURN_ACTIVE' }) }, sessionNodeIds: new Map([['resumed', 'node-7']]),
    appendTranscript: () => {}, treeStore: store, refusalCodeFromResult: value => value.code })
  assert.deepEqual(refused, { ok: false, code: 'AGENT_TURN_ACTIVE', firstTurnState: 'not-submitted' })
  const unbound = await sendResumeAssignment({ node, sessionId: 'resumed', assignment: ASSIGNMENT,
    bridge: { send: async () => assert.fail('an unbound session is never sent to') }, sessionNodeIds: new Map(), appendTranscript: () => {} })
  assert.equal(unbound.code, 'MC_TREE_COMMAND_SESSION_CHANGED')
})

test('through the production agent host, the assignment is the resumed session\'s first turn input', async () => {
  const workdir = mkdtempSync(path.join(SCRATCH, 'host-'))
  const engine = require_(ENGINE)
  engine.calls.length = 0
  engine.adapterCalls.length = 0
  const host = createAgentHost({ enginePath: ENGINE, defaultCwd: workdir, freeMemory: () => 64 * 1024 ** 3,
    confinementPlanner: () => ({ ok: true, tier: 'standard', isolated: true,
      threadOptions: { sandbox: 'workspace-write', approvalPolicy: 'never' },
      env: { CODEX_HOME: path.join(workdir, 'agent-home') }, servers: ['toolsenabled-readonly', 'toolsenabled'] }) })
  try {
    const started = await host.startSession({ sessionId: 'worker-resumed', resumeThreadId: 'saved-thread' })
    assert.equal(started.threadId, 'saved-thread')
    assert.equal(engine.calls.at(-1).resumed, true, 'the saved native conversation was resumed')
    assert.equal(engine.adapterCalls.filter(call => call.method === 'sendTurn').length, 0, 'a native resume sends nothing by itself')
    const node = { id: 'node-worker', sessionId: 'worker-resumed' }
    const result = await sendResumeAssignment({ node, sessionId: 'worker-resumed', assignment: ASSIGNMENT,
      bridge: { send: request => host.sendTurn(request) }, sessionNodeIds: new Map([['worker-resumed', node.id]]),
      appendTranscript: () => {}, treeStore: { getNode: () => node, setNodeStatus: () => {} } })
    assert.equal(result.firstTurnState, 'submitted')
    const turns = engine.adapterCalls.filter(call => call.method === 'sendTurn')
    assert.equal(turns.length, 1)
    assert.ok(turns[0].request.text.includes(resumeAssignmentSection(ASSIGNMENT)),
      'the first turn input the provider received carries the assignment')
  } finally {
    await host.closeAll().catch(() => {})
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})
