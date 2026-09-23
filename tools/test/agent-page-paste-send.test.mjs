/* THE PASTED IMAGE HAS TO REACH THE AGENT, NOT JUST THE COMPOSER.
 *
 * The owner, verbatim (2026-09-07): "pasted images still dont work".
 *
 * tools/test/agent-page-paste-attachment.test.mjs covers the PASTE half on the
 * agent page: the bytes reach the main process, the file is saved, a chip
 * appears. That half went green over a send path that drops the image on the
 * floor. Measured by signature at 6f89a9c0: src/components.js hands its sender
 * `onSend(v, { attachments, ... })`; src/views/agent.js took `(text, { reply,
 * fail })` and called `agentSessionController.send(text)`; src/agent-session.js
 * took `send(text)` and passed text alone to bridge.send. So the person saw a
 * chip, pressed Send, and the image never left the window.
 *
 * That is worse than the silence it replaced. A chip is a claim that the image
 * is going with the message; silence at least tells the truth. This codebase
 * treats the pattern as its own defect class
 * (tools/test/false-success-controls.test.mjs).
 *
 * The capability was never missing from the product, only from this sender:
 * src/views/computers.js's treeCardSend already maps attachments to
 * `{ path }` and hands them to `bridge.send({ ..., images })`. These cases pin
 * the same behaviour on the agent page's own composer, by CALLING the real
 * modules with values and reading what the bridge actually received.
 *
 * The resume decision, recorded because it is a product choice and not an
 * accident: a RESPAWN re-sends the words and NOT the image. Respawn replays
 * `lastPrompt`, which is text; an image the person attached to one turn is not
 * silently re-uploaded to a new child process they did not attach it to. Case 4
 * pins that, so a later change that starts carrying images on lastPrompt has to
 * argue with a test rather than slip through.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import { installDomStandIn } from './lib/dom-stand-in.mjs'

/* Let every pending microtask and timer-0 continuation settle. The surface
   sets `ready` inside an async IIFE after bridge.availability() resolves, so a
   send issued before that would measure the not-ready refusal instead of the
   path under test. */
const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise(resolve => setTimeout(resolve, 0)) }

/* A bridge we control, recording every send exactly as the surface issued it.
   Nothing here starts a process: `send` and `start` are this fixture's own. */
function recordingBridge () {
  const sends = []
  const calls = []
  return {
    sends,
    calls,
    availability: async () => ({ ok: true }),
    onEvent: () => () => {},
    start: async (arg) => { calls.push(['start', arg]); return { ok: true } },
    send: async (arg) => { sends.push(arg); calls.push(['send', arg]); return { ok: true, turnId: `turn-${sends.length}` } },
    close: async (arg) => { calls.push(['close', arg]); return { ok: true } },
    interrupt: async (arg) => { calls.push(['interrupt', arg]); return { ok: true } },
  }
}

/** Mount the real session surface and hand back its controller -- the same
 *  object the agent page's composer sends through. */
async function mountSurface (bridge) {
  const { document, restore } = installDomStandIn(globalThis)
  /* The Start control lives behind the write-action flag a person turns on
     themselves. Arranging that state is setup; the assertions still observe
     what the product does. */
  const store = new Map([['mc.write.agent-session', 'enabled']])
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)) },
    removeItem: (key) => { store.delete(key) },
  }
  try {
    const { mountAgentSessionSurface } = await import('../../src/agent-session.js')
    const root = document.createElement('div')
    document.body.appendChild(root)
    let control = null
    const dispose = mountAgentSessionSurface(root, {
      live: true,
      agentId: 'agent-1',
      bridge,
      onController: (value) => { control = value },
    })
    await settle()
    assert.ok(control, 'the session surface published no controller, so the composer has nothing to send through')
    return { control, dispose: () => { dispose(); restore() } }
  } catch (error) {
    restore()
    throw error
  }
}

test('an image on the first message rides the session start to the bridge', async () => {
  const bridge = recordingBridge()
  const { control, dispose } = await mountSurface(bridge)
  try {
    const sent = await control.send('look at this', { images: [{ path: 'C:\\scratch\\pasted.png' }] })
    assert.equal(sent.ok, true, 'the start refused; this case is about what a successful start carries')
    assert.equal(bridge.sends.length, 1)
    assert.deepEqual(bridge.sends[0].images, [{ path: 'C:\\scratch\\pasted.png' }],
      'the image the person attached never reached the bridge, so the chip in the composer was a false success')
    assert.equal(bridge.sends[0].text, 'look at this')
  } finally { dispose() }
})

test('an image on a later message rides the continue to the bridge', async () => {
  const bridge = recordingBridge()
  const { control, dispose } = await mountSurface(bridge)
  try {
    await control.send('first, no picture')
    /* A real product path back to an open, idle session: the person stops the
       running TURN (control.pause -- "stopped · turn interrupted · session
       still open"), and then sends again, this time with an image. */
    const stopped = await control.pause()
    assert.equal(stopped.ok, true, 'stopping the turn refused, so this case never reached the continue path')
    const sent = await control.send('now look at this', { images: [{ path: 'C:\\scratch\\second.png' }] })
    assert.equal(sent.ok, true)
    assert.equal(bridge.sends.length, 2)
    assert.deepEqual(bridge.sends[1].images, [{ path: 'C:\\scratch\\second.png' }],
      'the image was dropped on the continue path, so a second pasted image goes nowhere')
    assert.equal(bridge.sends[1].sessionId, bridge.sends[0].sessionId,
      'the continue opened a different session instead of carrying on the one that was already there')
  } finally { dispose() }
})

test('a message with nothing attached carries no images field at all', async () => {
  const bridge = recordingBridge()
  const { control, dispose } = await mountSurface(bridge)
  try {
    await control.send('just words')
    assert.equal(bridge.sends.length, 1)
    assert.equal(Object.prototype.hasOwnProperty.call(bridge.sends[0], 'images'), false,
      'a send with no attachment announced an images field, which asks the boundary to reason about an empty list')
  } finally { dispose() }
})

test('a respawn re-sends the words and not the image', async () => {
  const bridge = recordingBridge()
  const { control, dispose } = await mountSurface(bridge)
  try {
    await control.send('do the thing', { images: [{ path: 'C:\\scratch\\once.png' }] })
    const again = await control.respawn()
    assert.equal(again.ok, true, 'the respawn refused, so this case never reached the second start')
    assert.equal(bridge.sends.length, 2)
    assert.equal(bridge.sends[1].text, 'do the thing', 'the respawn did not replay the words it is defined to replay')
    assert.equal(Object.prototype.hasOwnProperty.call(bridge.sends[1], 'images'), false,
      'the respawn re-uploaded an image to a new child process the person never attached it to')
  } finally { dispose() }
})

/* ---- the view's own half: what the composer hands the sender ---------------
 *
 * Lift the whole `startOrContinue` arrow out of the real view and EVALUATE it
 * with every free name supplied, so the guard and the mapping run rather than
 * being read. Brace-matched from the arrow's own body, so reformatting or
 * renaming its locals cannot fake a red; a name the function needs and this
 * list does not supply is a ReferenceError, which is the honest outcome. */
const agentSource = readFileSync(new URL('../../src/views/agent.js', import.meta.url), 'utf8')

function liftStartOrContinue (source) {
  const start = source.indexOf('const startOrContinue = ')
  if (start === -1) return null
  const arrow = source.indexOf('=>', start)
  if (arrow === -1) return null
  const open = source.indexOf('{', arrow)
  if (open === -1) return null
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start + 'const startOrContinue = '.length, i + 1)
    }
  }
  return null
}

function makeStartOrContinue ({ send, sessionId = null }) {
  const expression = liftStartOrContinue(agentSource)
  assert.ok(expression, 'the agent page has no startOrContinue, so its composer reaches nothing')
  const factory = new Function('deps', `
    let chatReply = null
    let chatFail = null
    let chatTurnText = ''
    let chatBreakPending = false
    let chatThinkingText = ''
    let chatSessionId = null
    /* startOrContinue clears and reads the real session text reader before
       sending. This lifted composer fixture does not mount that reader, so
       provide its collaborator contract without replacing the behavior under
       test: attachment values still reach the recording collaborator below. */
    const chatTextReader = { clear: () => {}, read: () => null }
    /* settleChatThinking is a view-local that startOrContinue has called on its
       session-end and restart paths since 5b4d7732 (readable thinking rows). It
       folds unfinished thinking rows into the transcript, which this half does
       not observe; supplying it keeps the lifted arrow evaluable. */
    const settleChatThinking = () => {}
    const { isWriteEnabled, START_CONTROL_FLAG, startControlOffReason, liveSessionFor, agent, agentSessionController, startRefusal } = deps
    return (${expression})
  `)
  return factory({
    isWriteEnabled: () => true,
    START_CONTROL_FLAG: 'agent-session',
    startControlOffReason: () => 'Running agents is switched off.',
    liveSessionFor: () => (sessionId ? { sessionId } : null),
    agent: { id: 'agent-under-test' },
    agentSessionController: { send },
    startRefusal: (error, sentence) => sentence,
  })
}

test("the composer's attachments reach the sender as image paths", async () => {
  const calls = []
  const startOrContinue = makeStartOrContinue({
    send: async (text, options) => { calls.push([text, options]); return { ok: true, sessionId: 'session-9' } },
  })
  await startOrContinue('look at this', {
    reply: () => {},
    fail: (sentence) => { throw new Error(`the composer refused: ${sentence}`) },
    /* Exactly what src/components.js hands a sender: the pending attachment
       objects themselves, which carry a saved path among other fields. */
    attachments: [{ path: 'C:\\scratch\\pasted.png', name: 'pasted.png', size: 3 }],
  })

  assert.equal(calls.length, 1, 'the composer never reached the session controller at all')
  assert.equal(calls[0][0], 'look at this')
  assert.deepEqual(calls[0][1]?.images, [{ path: 'C:\\scratch\\pasted.png' }],
    'the agent page dropped the attachment between the composer and the session, so the chip promised a send that did not happen')
})

test('a send with no attachment asks the session for nothing extra', async () => {
  const calls = []
  const startOrContinue = makeStartOrContinue({
    sessionId: 'session-9',
    send: async (text, options) => { calls.push([text, options]); return { ok: true, sessionId: 'session-9' } },
  })
  await startOrContinue('just words', { reply: () => {}, fail: (sentence) => { throw new Error(`the composer refused: ${sentence}`) } })

  assert.equal(calls.length, 1)
  const options = calls[0][1]
  assert.ok(!options || !Object.prototype.hasOwnProperty.call(options, 'images'),
    'a plain message announced an images field, which asks every layer below to reason about an empty list')
})

/* ---- T18 cycle 2: the picture that did NOT go has to be said out loud ------
 *
 * shell/agent-host.cjs sendTurn answers a turn whose provider cannot carry the
 * picture with `pictureNotSent` -- provider, file names, and one plain sentence
 * already written for the person -- and sends the words alone;
 * shell/node-transcript-capture.cjs files that sentence as its own row in the
 * durable record. Two independent searches on 2026-09-16 found no renderer
 * reading it on any surface, so the composer's chip vanished, the words went,
 * the agent answered about a picture it never received, and the sentence
 * existed only on disk. These cases hold the seam open on the agent page: the
 * session surface must carry the receipt, and the composer must say it.
 */

test('the session surface carries the host\'s picture-not-sent receipt back to its caller', async () => {
  const sentence = 'The picture holiday.png was not sent: this agent cannot look at pictures, because a local model session in this build takes words only. Your message was sent without it.'
  const bridge = recordingBridge()
  bridge.send = async (arg) => {
    bridge.sends.push(arg)
    return { ok: true, turnId: 'turn-1', pictureNotSent: { provider: 'local', files: ['holiday.png'], sentence } }
  }
  const { control, dispose } = await mountSurface(bridge)
  try {
    const sent = await control.send('what is in this picture?', { images: [{ path: 'C:\\scratch\\holiday.png' }] })
    assert.equal(sent.ok, true)
    assert.equal(sent.pictureNotSent?.sentence, sentence,
      'the session surface dropped the host\'s refusal receipt, so no surface above it can tell the person the picture did not go')
  } finally { dispose() }
})

test('the agent page composer says the picture-not-sent sentence, as a product note and not as a refusal', async () => {
  const sentence = 'The picture holiday.png was not sent: this agent cannot look at pictures, because a local model session in this build takes words only. Your message was sent without it.'
  const said = { notes: [], failures: [], replies: [] }
  const startOrContinue = makeStartOrContinue({
    sessionId: 'session-9',
    send: async () => ({ ok: true, sessionId: 'session-9', pictureNotSent: { provider: 'local', files: ['holiday.png'], sentence } }),
  })
  await startOrContinue('what is in this picture?', {
    reply: text => said.replies.push(text),
    fail: text => said.failures.push(text),
    note: text => said.notes.push(text),
    attachments: [{ path: 'C:\\scratch\\holiday.png', name: 'holiday.png', size: 3 }],
  })

  assert.deepEqual(said.notes, [sentence],
    'the agent page took the picture, sent the words alone and said nothing -- the person has no way to know the picture did not go')
  assert.deepEqual(said.failures, [],
    'a send that succeeded was painted as a refusal; the person\'s message did go')
})

test('a send whose picture DID go says nothing extra', async () => {
  const said = []
  const startOrContinue = makeStartOrContinue({
    sessionId: 'session-9',
    send: async () => ({ ok: true, sessionId: 'session-9' }),
  })
  await startOrContinue('what is in this picture?', {
    reply: () => {}, fail: text => said.push(['fail', text]), note: text => said.push(['note', text]),
    attachments: [{ path: 'C:\\scratch\\holiday.png', name: 'holiday.png', size: 3 }],
  })
  assert.deepEqual(said, [], 'a delivered picture produced a note, which would tell the person something untrue')
})
