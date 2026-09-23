/* "NOTHING HERE WILL START AN AGENT" HAS TO BE TRUE OF THE PAGE THAT STARTS THEM.
 *
 * Answer "Nothing yet — let me look around first" in setup and the product says,
 * in its own words on that screen: "With this answer, nothing here will start an
 * agent." It makes that true by leaving `mc.write.agent-session` disabled, and
 * src/agent-session.js asks -- it renders a switched-off surface instead of a
 * Start control.
 *
 * src/views/computers.js never asked. Measured on the packaged build
 * 2026-08-16 on a fresh profile that gave exactly that answer: the dashed "+"
 * opened its panel, "Start this agent" went all the way to the engine, and what
 * came back was an ENGINE refusal about Codex. The promise was kept by the page
 * a fresh install cannot even route to, and broken by the page it opens on.
 *
 * The flag now gates every path on that page that reaches bridge.start: the
 * compose panel, the submit behind it, Resume/restart, "start over", and the
 * dead-session recovery. Each of those is a real child process on the person's
 * computer, and each one of them was reachable.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { parseAst } from 'rollup/parseAst'

import { AUTONOMY_CHOICES, PROFILE_SCHEMA_VERSION, PROFILE_STORAGE_KEY, START_CONTROL_FLAG, startControlOffBecause, startControlOffReason } from '../../src/setup-profile.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const view = readFileSync(join(ROOT, 'src', 'views', 'computers.js'), 'utf8')
const session = readFileSync(join(ROOT, 'src', 'agent-session.js'), 'utf8')

// AST boundaries keep each actual function separate as queued Resume evolves.
const functions = new Map()
function collectFunctions(node) {
  if (!node || typeof node !== 'object') return
  if (node.type === 'FunctionDeclaration') {
    const entries = functions.get(node.id.name) || []
    entries.push(node)
    functions.set(node.id.name, entries)
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(collectFunctions)
    else if (value && typeof value === 'object') collectFunctions(value)
  }
}
collectFunctions(parseAst(view))
function actualFunction(name) {
  const entries = functions.get(name) || []
  assert.equal(entries.length, 1, `${name} must remain uniquely identifiable`)
  return view.slice(entries[0].start, entries[0].end)
}

const storedProfile = autonomy => ({
  localStorage: {
    getItem: key => (key === PROFILE_STORAGE_KEY
      ? JSON.stringify({ schemaVersion: PROFILE_SCHEMA_VERSION, status: 'complete', step: 'review', answers: { autonomy, screens: 'live' } })
      : null),
    setItem: () => {},
  },
})

test('the flag that decides whether an agent can start has exactly one name', () => {
  assert.equal(START_CONTROL_FLAG, 'agent-session')
})

test('the reason names the answer the person actually gave', () => {
  const observe = AUTONOMY_CHOICES.find(choice => choice.value === 'observe')
  const because = startControlOffBecause(storedProfile('observe'))
  assert.ok(because.includes(observe.label),
    'the explanation does not quote the answer that switched starting off, so it reads as the product deciding by itself')

  /* A machine with no recorded profile turned it off in Settings, and must not
     be told setup did it. */
  const noProfile = startControlOffBecause({ localStorage: { getItem: () => null, setItem: () => {} } })
  assert.doesNotMatch(noProfile, /Setup recorded/,
    'somebody who turned this off themselves is told setup did it')
  assert.ok(noProfile.length > 0)

  /* Storage that throws is not a reason to throw. */
  assert.ok(startControlOffBecause({ localStorage: { getItem() { throw new Error('quota') } } }).length > 0)
})

test('both screens that explain this switch say the same first sentence', () => {
  assert.match(session, /startControlOffBecause\(\)/,
    'the agent page grew its own copy of the explanation again')
  assert.match(view, /startControlOffReason\(\)/,
    'the fleet page stopped using the shared full refusal')
  const because = startControlOffBecause(storedProfile('observe'))
  const reason = startControlOffReason(storedProfile('observe'))
  assert.equal(reason.slice(0, because.length), because,
    'the shared full refusal no longer begins with the sentence the agent page uses')
})

test('every path on the fleet page that reaches bridge.start asks the flag first', () => {
  /* One assertion per START, because each was independently reachable. */
  const gate = /isWriteEnabled\(START_CONTROL_FLAG\)/

  const panel = view.slice(view.indexOf('function composeUnavailableReason'), view.indexOf('function composeUnavailableReason') + 1600)
  assert.match(panel, gate, 'the compose panel opens with a live Start on a computer that promised none')

  /* LANDMARK-BOUNDED, not a fixed character count: a fixed window broke here
     once already (an explanatory comment on the mode-decision line pushed the
     gate past a hardcoded +1200) even though the gate itself never moved.
     submitCompose's own next sibling function is the honest boundary. */
  const submit = view.slice(view.indexOf('async function submitCompose'), view.indexOf('async function startDraftNode'))
  assert.match(submit, gate, 'the submit still reaches the engine; the panel alone is paint, not a gate')
  assert.ok(submit.indexOf('isWriteEnabled(START_CONTROL_FLAG)') < submit.indexOf('store.addNode'),
    'the refusal comes after a node has been created, so a switched-off computer collects half-started agents')

  /* THE OPEN PAREN IS LOAD-BEARING, not decoration: 'async function
     resumeNodeSession' (no paren) is also a PREFIX of 'async function
     resumeNodeSessionUnguarded', its own next sibling below. A bare-name
     search that landed there instead -- say, because resumeNodeSession's
     wrapper alone was ever renamed while its Unguarded twin was not -- would
     silently slide this whole window eleven lines into the wrong function.
     Measured: with only the wrapper renamed, indexOf still found
     resumeNodeSessionUnguarded's declaration, the shifted 1400-char window
     still happened to contain that function's OWN gate check, and this test
     still reported green while verifying code the wrapper it meant to name
     was never asked about at all. The trailing '(' rules the Unguarded
     sibling out; the notEqual below rules out a landmark that is gone
     entirely, which the same drift produces as an unhelpful `actual: ''`
     with no name in the failure at all. */
  const resumeAt = view.indexOf('async function resumeNodeSession(')
  assert.notEqual(resumeAt, -1, 'resumeNodeSession was renamed or removed -- the Resume gate can no longer be located')
  const resumeBodyAt = view.indexOf('async function resumeNodeSessionUnguarded(', resumeAt)
  const resumeEnd = view.indexOf('async function runPaletteAction(', resumeBodyAt)
  assert.ok(resumeBodyAt > resumeAt && resumeEnd > resumeBodyAt,
    'Resume wrapper, body, and next sibling must remain ordered')
  const resumeWrapper = actualFunction('resumeNodeSession')
  assert.match(resumeWrapper, /nodeReplacementFlight\.run\(/,
    'Resume must keep the shared replacement guard; both call paths are executed below')
  const resume = view.slice(resumeBodyAt, resumeEnd)
  assert.ok(resume.indexOf('isWriteEnabled(START_CONTROL_FLAG)') < resume.indexOf('await ensureSeatForNode('),
    'Resume must refuse before allocating a replacement seat')
  assert.match(resume, gate, 'Resume starts a real agent on a computer where starting is switched off')

  const clearAt = view.indexOf("if (id === 'clear')")
  assert.notEqual(clearAt, -1, 'the palette lost its clear/"Start over" row')
  const resumeRowAt = view.indexOf("if (id === 'resume')", clearAt)
  assert.notEqual(resumeRowAt, -1, 'the palette lost its resume row, or it moved before "Start over"')
  const clear = view.slice(clearAt, resumeRowAt)
  assert.match(clear, /freshStartExistingNode\(node\)/,
    '"Start over" bypasses the shared replacement gate')
  /* Both lanes sliced the same span; this one also asks whether the two
     landmarks are still there and still in that order. A bare
     view.slice(indexOf(a), indexOf(b)) answers -1 for a landmark that was
     renamed away and silently hands back an empty (or backwards) string, so
     every assert.match below it passes vacuously on nothing. */
  const freshStartUnguardedAt = view.indexOf('async function freshStartExistingNodeUnguarded')
  assert.notEqual(freshStartUnguardedAt, -1, 'freshStartExistingNodeUnguarded was renamed or removed')
  assert.ok(resumeAt > freshStartUnguardedAt,
    'resumeNodeSession no longer sits after freshStartExistingNodeUnguarded -- the replacement slice below would be empty or run backwards')
  const replacement = view.slice(freshStartUnguardedAt, resumeAt)
  assert.match(replacement, /canStart:\s*\(\)\s*=>\s*isWriteEnabled\(START_CONTROL_FLAG\)/,
    'the replacement lifecycle starts a real agent on a computer where starting is switched off')

  const recovery = view.slice(view.indexOf('async function recoverDeadSessionSend'), view.indexOf('async function recoverDeadSessionSend') + 900)
  assert.match(recovery, gate, 'a dead-session send quietly starts a fresh agent where starting is switched off')
})

test('the refusal tells a person where the switch is', () => {
  /* The wording moved to setup-profile.js so every refusal uses one function.
     Exercise that function instead of slicing for the deleted private copy. */
  const reason = startControlOffReason(storedProfile('observe'))
  assert.match(reason, /Settings/, 'the refusal names no place to change it, which is a dead end')
  assert.match(reason, /starts nothing by itself/,
    'the switch is offered with only its benefit named, or with no idea what it does')
})

function resumeGateFixture() {
  const node = { id: 'node', treeId: 'tree', tier: 'codex', role: 'worker', sessionId: 'saved' }
  const calls = []
  const nextBoundary = new Error('resume passed the start switch')
  const state = { enabled: false }
  const context = {
    recoveryCoordinator: () => null,
    treeStore: { getNode: () => node }, transcriptStore: {}, destroyed: false,
    nodeReplacementFlight: { run: async (id, run) => {
      calls.push(['flight', id])
      return { ran: true, value: await run() }
    } },
    retainStartingTreeStore: () => () => calls.push(['release']),
    window: { mcAgent: {
      start: () => { calls.push(['start']); throw Error('unexpected provider start') },
      close: () => { calls.push(['close']); throw Error('unexpected provider close') },
    } },
    START_CONTROL_FLAG,
    isWriteEnabled: flag => { assert.equal(flag, START_CONTROL_FLAG); calls.push(['flag', state.enabled]); return state.enabled },
    startControlOffReason: () => startControlOffReason(storedProfile('observe')),
    nodeCleanupPending: () => { calls.push(['after-switch']); throw nextBoundary },
    ensureSeatForNode: () => { calls.push(['seat']); throw Error('unexpected replacement seat') },
    RESUME_PANEL: { underway: 'Already resuming', failed: 'Resume failed' },
  }
  return { node, calls, state, context, nextBoundary }
}

test('the actual Resume wrapper refuses before replacement work when starts are disabled, and reaches it when enabled', async () => {
  const { node, calls, state, context, nextBoundary } = resumeGateFixture()
  const resume = runInNewContext(`${actualFunction('resumeNodeSessionUnguarded')}
(${actualFunction('resumeNodeSession')})`, context)
  const out = { textContent: '' }
  assert.equal(await resume(node, { out }), false)
  assert.equal(out.textContent, startControlOffReason(storedProfile('observe')))
  assert.deepEqual(calls, [['flight', node.id], ['flag', false], ['release']])
  // Positive control: this is the real gate, not a fixture that always refuses.
  calls.length = 0
  state.enabled = true
  await assert.rejects(resume(node, { out }), error => error === nextBoundary)
  assert.deepEqual(calls, [['flight', node.id], ['flag', true], ['after-switch'], ['release']])
})

test('a queued Resume retry checks the current disabled switch through the actual body', async () => {
  const { node, calls, state, context } = resumeGateFixture()
  const body = runInNewContext(`(${actualFunction('resumeNodeSessionUnguarded')})`, context)
  let attempts = 0, queueAttempts = 0
  state.enabled = true
  Object.assign(context, {
    // Inject the initial resource hold and queue timing. The Resume queue
    // wrapper, replacement wrapper, and retry's switch check are shipping functions.
    resumeNodeSessionUnguarded: async (current, options) => {
      attempts++
      if (attempts === 1) {
        options.onRefused({ retryable: true, code: 'AGENT_RESOURCE_PRESSURE', resumeTarget: { threadId: 'thread' } })
        return false
      }
      assert.equal(options.expectedResume.threadId, 'thread')
      assert.equal(options.expectedResume.nodeIdentity.sessionId, 'saved')
      return body(current, options)
    },
    isResourceHold: code => code === 'AGENT_RESOURCE_PRESSURE',
    nodeLaunchQueues: new Map(), refreshTreeStartControls() {}, refreshLaunchStatus() {}, setOrgStatus() {},
    createTreeLaunchQueue: ({ start }) => ({
      snapshot: () => ({ cancelled: false }),
      done: Promise.resolve().then(async () => {
        queueAttempts++
        assert.equal((await start(node)).code, 'AGENT_RESOURCE_PRESSURE')
        state.enabled = false // The person changes Settings while Resume waits.
        queueAttempts++
        return { results: [await start(node)], cancelled: false }
      }),
    }),
  })
  const resume = runInNewContext(`${actualFunction('resumeNodeSessionQueued')}
(${actualFunction('resumeNodeSession')})`, context)
  assert.equal(await resume(node, { out: { textContent: '' } }), false)
  assert.equal(attempts, 2)
  assert.equal(queueAttempts, 2, 'the queue must replay the hold before attempting Resume again')
  assert.deepEqual(calls, [['flight', node.id], ['flag', false], ['release']])
  assert.equal(context.nodeLaunchQueues.size, 0)
  assert.equal(node.sessionId, 'saved')
})
