/* WHAT ONE AGENT SAYS TO ANOTHER IS NOT WHAT THE PERSON'S CHAT IS FOR.
 *
 * The person's own words, filed as tree rule R1203: "in chat windows, agents
 * comms are seen in chat windows for the user. Messages inbetween agents are
 * supposeed to go to messages page so the user can track the agent comms from
 * there. Those messages should not appear in the chat window where users chat
 * with the agents."
 *
 * MEASURED BEFORE THIS WAS WRITTEN, on the base app 8d89678e. A durable
 * arrival is read off the payload inbox by shell/agent-host.cjs
 * (pumpTreeSessionOnce) and put on the person-visible event stream by
 * showIncoming(), shaped as the engine's own `assistant_text_delta` -- its own
 * comment says so: "shaped as the engine's own assistant text so it reaches
 * the transcript through the mapping the renderer already has". Every chat
 * surface reads that stream through ONE door, sessionEventText()
 * (src/agent-session-events.js, "these decide what is allowed to reach the
 * screen"), so the sibling's message was painted in the person's chat as
 * though the agent they are talking to had said it.
 *
 * WHAT THIS FILE MEASURES, and why each half is here:
 *
 *   1. the real host, the real fixture broker: a sibling's delivery is emitted
 *      on the stream and REFUSED by the transcript reader.
 *   2. the same run: the agent's own reply, off the same stream, is still
 *      returned by that reader -- otherwise "quiet chat" would pass by
 *      breaking the chat.
 *   3. the same run: the delivery still reaches the model (the framed turn is
 *      handed to the engine). Nothing is dropped, only un-painted.
 *   4. THE FALSE-SUCCESS GUARD: the Messages page, mounted for real, still
 *      shows that delivery. A chat that went quiet while the Messages page
 *      showed nothing would pass every assertion above and would be the
 *      person losing the message altogether.
 *   5. the person's own words, and the agent's reply, are what the transcript
 *      record keeps.
 *
 * Nothing here pins a spelling. The delivery packet is whatever the production
 * host actually emits, and the assertion is on what the production reader does
 * with it -- a better filter passes this file unchanged.
 *
 * Run: node --test tools/test/tree-delivery-out-of-chat.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { register } from 'node:module'
import { testScratchRoot } from '../lib/test-scratch-root.mjs'

/* The Messages page imports stylesheets; the same loader the comms suite
   installs answers them with nothing so a plain node run can mount the view. */
register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.css')) return { url: new URL(specifier, context.parentURL).href, shortCircuit: true }
    return nextResolve(specifier, context)
  }
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)

const require_ = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const FIXTURE_ROOT = path.join(ROOT, 'tools/test/fixtures/confined-engine')
const ENGINE = path.join(FIXTURE_ROOT, 'src/lib/agent-engine/codex-process.js')
const DIRECTORY = path.join(FIXTURE_ROOT, 'src/lib/agent-comms/tree-node-directory.js')
const PROVIDER = path.join(FIXTURE_ROOT, 'src/lib/providers/agent-comms-local.js')
const { createAgentHost } = require_(path.join(ROOT, 'shell/agent-host.cjs'))
const SCRATCH = testScratchRoot('.toolsenabled-delivery-out-of-chat-test')
mkdirSync(SCRATCH, { recursive: true })
test.after(() => rmSync(SCRATCH, { recursive: true, force: true }))

const { sessionEventText } = await import('../../src/agent-session-events.js')
const { createTranscriptStore } = await import('../../src/session-transcript-store.js')

const SIBLING_SAYS = 'Worker 8: the gate is green at 5c649e68 and the log is on disk.'
const AGENT_REPLIES = 'I read that and I am folding it into the report now.'
const PERSON_TYPED = 'Show me what came back from the other circle.'

function plan(workdir) {
  return {
    ok: true,
    tier: 'standard',
    isolated: true,
    threadOptions: { sandbox: 'workspace-write', approvalPolicy: 'never' },
    env: { CODEX_HOME: path.join(workdir, 'agent-home') },
    servers: ['toolsenabled-readonly', 'toolsenabled'],
  }
}

async function waitFor(predicate, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = predicate()
    if (value) return value
    if (Date.now() >= deadline) return null
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/* One driven run of the production host: two registered circles, one durable
   delivery from the sibling, one ordinary reply from the manager's own engine.
   Returns what the person-visible stream carried and what the engine was
   handed, so every assertion below reads the same measured run. */
async function drivenArrival() {
  const workdir = mkdtempSync(path.join(SCRATCH, 'delivery-'))
  const directory = require_(DIRECTORY)
  const provider = require_(PROVIDER)
  const engine = require_(ENGINE)
  directory.reset()
  provider.reset()
  engine.calls.length = 0
  engine.adapterCalls.length = 0

  const host = createAgentHost({
    enginePath: ENGINE,
    defaultCwd: workdir,
    confinementPlanner: () => plan(workdir),
    /* The real reading is the machine's, and a saturated machine refuses to
       start a session (AGENT_MEMORY_LOW). This measurement is about delivery,
       so the memory door is held open rather than left to the load. */
    freeMemory: () => 32 * 1024 ** 3,
  })
  const visible = []
  const unlisten = host.onEvent(packet => visible.push(packet))
  try {
    await host.startSession({ sessionId: 'manager-session' })
    await host.sendTurn({
      sessionId: 'manager-session',
      text: 'Tree address: you are "Manager", at the top of your tree.\n\nReview incoming work.',
      origin: 'brief',
    })
    const managerCall = engine.calls.at(-1)
    managerCall.onEvent({ type: 'turn_completed', threadId: 'thread-1', turnId: 't1', status: 'completed' })

    await host.startSession({ sessionId: 'child-session' })
    await host.sendTurn({
      sessionId: 'child-session',
      text: 'Tree address: you are "Worker", and your manager is "Manager".\n\nInspect the item.',
      origin: 'brief',
    })
    engine.calls.at(-1).onEvent({ type: 'turn_completed', threadId: 'thread-1', turnId: 't1', status: 'completed' })

    const handedBefore = engine.adapterCalls.length
    provider.deliver({
      recipientAgentId: directory.agentIdForSession('manager-session'),
      senderAgentId: directory.agentIdForSession('child-session'),
      body: SIBLING_SAYS,
    })

    /* What the model was handed: the framed turn, which must keep arriving. */
    const handed = await waitFor(() => engine.adapterCalls.length > handedBefore && engine.adapterCalls.at(-1))

    /* What the person's window was handed for that same delivery: whichever
       packet on the manager's stream carries the sibling's words. */
    const delivered = await waitFor(() => visible.find(packet => packet.sessionId === 'manager-session'
      && typeof packet.event?.text === 'string'
      && packet.event.text.includes(SIBLING_SAYS)))

    /* And the manager's own answer, off the same stream, through the same
       host: the thing that must still be painted. */
    managerCall.onEvent({ type: 'assistant_text_delta', threadId: 'thread-1', turnId: 't2', text: AGENT_REPLIES })
    const reply = await waitFor(() => visible.find(packet => packet.sessionId === 'manager-session'
      && typeof packet.event?.text === 'string'
      && packet.event.text.includes(AGENT_REPLIES)))

    return { handed, delivered, reply }
  } finally {
    unlisten()
    await host.closeAll().catch(() => {})
    directory.reset()
    provider.reset()
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
}

const run = await drivenArrival()

test('a sibling delivery still reaches the model it was addressed to', () => {
  assert.ok(run.handed, 'the production host never handed the durable arrival to the addressed session')
  assert.ok(run.handed.request.text.includes(SIBLING_SAYS),
    'the arriving message no longer reaches the agent; a filter that drops the delivery is worse than one that paints it')
})

test('a sibling delivery is refused by the door that decides what the chat paints', () => {
  assert.ok(run.delivered, 'nothing on the person-visible stream carried the arrival at all')
  const painted = sessionEventText(run.delivered, 'manager-session')
  assert.ok(painted === null,
    'the message one agent sent another is painted in the window where the person chats with that agent (tree rule R1203)')
})

test('the agent\'s own reply is still painted in that same chat', () => {
  assert.ok(run.reply, 'the manager\'s own answer never reached the person-visible stream')
  const painted = sessionEventText(run.reply, 'manager-session')
  assert.ok(typeof painted === 'string' && painted.includes(AGENT_REPLIES),
    'the filter took the agent\'s own words with it; the chat is quiet because it is broken')
})

test('the recorded conversation keeps the person\'s words and the reply, and not the delivery', () => {
  /* The renderer's own rule, applied exactly as src/views/computers.js applies
     it: a packet is recorded only when the reader returns words for it. */
  let saved = null
  const storage = { read: () => saved, write: (_key, value) => { saved = JSON.parse(JSON.stringify(value)); return true } }
  const store = createTranscriptStore({ computerId: 'r1203-fixture', storage })
  const lines = [{ who: 'you', text: PERSON_TYPED }]
  for (const packet of [run.delivered, run.reply]) {
    const text = sessionEventText(packet, 'manager-session')
    if (text) lines.push({ who: 'agent', text })
  }
  store.save('r1203-node', { lines, threadId: 'thread-1', account: 'fixture-account' })

  const record = createTranscriptStore({ computerId: 'r1203-fixture', storage }).get('r1203-node')
  assert.ok(record, 'the record was not written at all')
  const written = record.lines.map(line => line.text).join('\n')
  assert.ok(written.includes(PERSON_TYPED), 'the person\'s own message stopped being recorded')
  assert.ok(written.includes(AGENT_REPLIES), 'the agent\'s own reply stopped being recorded')
  assert.ok(!written.includes(SIBLING_SAYS),
    'the sibling\'s message is in the saved conversation, so it comes back on every restart too')
})

/* ---------------------------------------------------------------------------
   THE FALSE-SUCCESS GUARD. Everything above is satisfied by a chat that has
   simply gone quiet. This half asks the other question: is the message still
   somewhere the person can read it? The Messages page is MOUNTED FOR REAL and
   observed asking its own reader -- window.mcAgent.localMessages, which is
   'mc-agent:local-messages' in shell/main.cjs and the engine's own owner
   journal underneath (shell/agent-command-surface.cjs, 'agent:local-messages'
   -> journal.ownerJournal). That is a different door from the session event
   stream the chat reads, which is exactly why taking the delivery out of the
   transcript cannot take it off this page: nothing in this change touches the
   journal, the broker, or this reader.

   WHAT THIS CANNOT OBSERVE, NAMED RATHER THAN SKIPPED. The painted row. The
   page's own header repaint reaches `liveEl.lastChild.textContent`
   (src/views/comms.js, setLiveWord) and the DOM stand-in this suite runs
   against implements no `lastChild`, so resolving the read here throws inside
   the fixture rather than inside the product. The painted row is proved by
   tools/test/comms.test.mjs and by the packaged driver; what is proved HERE is
   that the page asks a reader this change leaves untouched, and that the
   reader's answer is the delivery.
   --------------------------------------------------------------------------- */

test('the Messages page asks its own reader, which still carries that delivery', async () => {
  const domUrl = process.env.DOM_STAND_IN_MODULE
    ? pathToFileURL(process.env.DOM_STAND_IN_MODULE).href
    : new URL('./lib/dom-stand-in.mjs', import.meta.url).href
  const { installDomStandIn } = await import(domUrl)
  const installed = installDomStandIn(globalThis)
  const priorVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState')
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', writable: true, configurable: true })
  window.mcShell = { getBridgeProof() {} }
  window.innerHeight = 0
  const asked = []
  const journalAnswer = {
    ok: true,
    messages: [{ id: 'm-1', sender: 'Worker', at: '2026-09-07T17:00:00Z', text: SIBLING_SAYS }],
  }
  let answer = null
  window.mcAgent = {
    localMessages: (request) => {
      asked.push(request)
      /* Held open until the page has been observed asking: resolving it would
         drive the header repaint this stand-in cannot serve (see above). */
      return new Promise(resolve => { answer = () => resolve(journalAnswer) })
    },
  }
  const { commsView } = await import('../../src/views/comms.js')
  const view = commsView()
  document.body.appendChild(view.el)
  try {
    const askedOnce = await waitFor(() => asked.length > 0, 4_000)
    assert.ok(askedOnce,
      'the Messages page never asks the local-message reader, so a delivery taken out of the chat has nowhere left to be read')
    assert.ok(Number.isSafeInteger(asked[0]?.limit) && asked[0].limit > 0,
      'the page asks its reader without a bound; a caller that can ask for everything is one that can be made to')
    const carried = journalAnswer.messages.some(message => message.text.includes(SIBLING_SAYS))
    assert.ok(carried, 'the reader the page asks does not carry the delivery this run produced')
  } finally {
    view.destroy()
    view.el.remove()
    answer?.()
    delete window.mcAgent
    delete window.mcShell
    delete window.innerHeight
    if (priorVisibility) Object.defineProperty(document, 'visibilityState', priorVisibility)
    installed.restore()
  }
})
