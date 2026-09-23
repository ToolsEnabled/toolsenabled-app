/* A PASTE MADE BEFORE THE AGENT IS LIVE IN THIS RUN.
 *
 * REPRODUCED FIRST, at 881f003c (probe dh-c-repro-unknown-session-20260907.mjs):
 * the tree rail offers paste whenever the bridge exposes it -- never gated on
 * the session being live -- and it sends `node.sessionId`, which for a saved
 * conversation is an id minted in a PREVIOUS run of the app. main's
 * agentSessions map does not hold it, so ownedAgentSession throws
 * MC_AGENT_UNKNOWN_SESSION BEFORE savePasteAttachment is ever called, and
 * pasteRefusalSentence -- which knows only three codes and falls through for
 * everything else -- shows the person "That pasted image could not be
 * attached." No file is written. That is the never-written paste-attachments
 * directory and the person's "It says it couldnt get the image", one mechanism.
 *
 * THE FIX, to Controller 2's design: the person's own window may paste for a
 * conversation its window is showing even before a live session exists. The
 * file is saved and held against the CONVERSATION (the node id the window
 * names), and the binding to a session is deferred to send time, where
 * ownedAgentSession is checked exactly as it is today.
 *
 * WHAT IS DELIBERATELY NOT WIDENED, and these cases pin it:
 *   - only a window principal; a relay or agent caller is refused as before;
 *   - only a hold this same owner made; another owner cannot claim it;
 *   - a path nobody ever issued is still refused MC_AGENT_ATTACHMENT_UNKNOWN,
 *     which is the fence that makes the whole attachment allowlist mean
 *     something ("only paths issued by THIS principal's own picker for THIS
 *     session");
 *   - a paste with no conversation named and no live session is refused
 *     exactly as it is today, so nothing is widened by accident.
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import { sendFailureIsUnconfirmed, sendRefusalSentence } from '../../src/fleet-tree-copy.js'

const require = createRequire(import.meta.url)
const { createAgentCommandSurface, REQUIRED_DEPS } = require('../../shell/agent-command-surface.cjs')

const PNG = Buffer.from([137, 80, 78, 71]).toString('base64')

/* Every declared dependency stubbed by its declared kind -- generated from
   REQUIRED_DEPS itself, so a dependency added later cannot be silently missing
   here -- then the few this command really uses given real behaviour. */
function surfaceFixture({ sessions = new Map() } = {}) {
  const deps = {}
  for (const [name, kind] of Object.entries(REQUIRED_DEPS)) {
    deps[name] = kind === 'function' ? (() => {}) : kind === 'number' ? 4096 : kind === 'string' ? '' : {}
  }
  const saved = []
  const sent = []
  let sequence = 0
  deps.dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
  deps.AGENT_EFFORT_VALUES = ['low', 'medium', 'high']
  deps.sessionProfiles = { list: () => [], create: () => ({}), remove: () => true, resolveCwd: () => '' }
  deps.agentOrgRecord = { read: () => ({ ok: true }), resolveRoleBinding: () => ({ ok: true }) }
  deps.agentSessions = sessions
  deps.MAX_PASTE_IMAGE_BYTES = 8 * 1024 * 1024
  deps.agentIpcError = (code, message) => { throw Object.assign(new Error(message || code), { code }) }
  deps.rendererSafeAgentError = error => error
  deps.parseAgentPasteAttachment = value => ({
    sessionId: value.sessionId,
    mime: value.mime,
    data: value.data,
    ...(value.holdKey === undefined ? {} : { holdKey: value.holdKey }),
  })
  deps.parseAgentSend = value => ({
    sessionId: value.sessionId,
    text: value.text,
    ...(value.images ? { images: value.images } : {}),
    ...(value.holdKey === undefined ? {} : { holdKey: value.holdKey }),
  })
  deps.savePasteAttachment = (mime, bytes) => {
    sequence += 1
    const record = { path: `C:\\fake\\paste-attachments\\img-${sequence}.png`, size: bytes.length, mime }
    saved.push(record)
    return record
  }
  deps.currentAgentHost = () => ({
    sendTurn: async (request) => { sent.push(request); return { sessionId: request.sessionId, turnId: 'turn-1' } },
  })
  deps.recordAcceptedTranscriptSend = async () => {}
  return { surface: createAgentCommandSurface(deps), saved, sent, sessions }
}

const windowPrincipal = (owner = 'owner-1') => ({ kind: 'window', owner, label: 'the ToolsEnabled window', mayWrite: true })
const relayPrincipal = (owner = 'owner-1') => ({ kind: 'relay', owner, label: 'the signed-in phone', mayWrite: true })

/* A session as main holds one once it is really running. */
const liveSession = (owner = 'owner-1') => ({ owner, ownerKind: 'window', state: 'running' })

async function refusal(run) {
  try { await run(); return null } catch (error) { return error.code || null }
}

test('a paste for a conversation whose agent is not live is saved and held, not refused', async () => {
  const fixture = surfaceFixture()
  const result = await fixture.surface.run('agent:paste-attachment', {
    /* What the rail really sends for a saved conversation: an id minted in a
       previous run, which main cannot know. */
    sessionId: 'session-from-a-previous-run',
    holdKey: 'node-7',
    mime: 'image/png',
    data: PNG,
  }, windowPrincipal())

  assert.equal(result.ok, true, 'the person\'s own window was refused a paste into a conversation its window is showing')
  assert.equal(typeof result.path, 'string')
  assert.ok(result.path, 'no file was written, so there is nothing to send later')
  assert.equal(fixture.saved.length, 1, 'the image never reached the disk')
})

test('the held image rides the first send once the conversation has a live session', async () => {
  const fixture = surfaceFixture()
  const paste = await fixture.surface.run('agent:paste-attachment', {
    sessionId: 'session-from-a-previous-run', holdKey: 'node-7', mime: 'image/png', data: PNG,
  }, windowPrincipal())

  /* The person presses Start (or Resume); main now really holds a session for
     that conversation. */
  fixture.sessions.set('session-now-live', liveSession())

  await fixture.surface.run('agent:send', {
    sessionId: 'session-now-live',
    holdKey: 'node-7',
    text: 'what is in this picture',
    images: [{ path: paste.path }],
  }, windowPrincipal())

  assert.equal(fixture.sent.length, 1, 'the send never reached the host')
  assert.deepEqual(fixture.sent[0].images, [{ path: paste.path }],
    'the held image did not ride the send, so the chip the person saw was a false success')
})

test('a held path is bound to the session, so a second send cannot replay it from the hold', async () => {
  const fixture = surfaceFixture()
  const paste = await fixture.surface.run('agent:paste-attachment', {
    sessionId: 'old', holdKey: 'node-7', mime: 'image/png', data: PNG,
  }, windowPrincipal())
  const session = liveSession()
  fixture.sessions.set('session-now-live', session)
  await fixture.surface.run('agent:send', {
    sessionId: 'session-now-live', holdKey: 'node-7', text: 'one', images: [{ path: paste.path }],
  }, windowPrincipal())

  /* Binding means the path is now the SESSION's, by the same allowlist every
     picked attachment uses -- not a second, looser door that stays open. */
  assert.ok(session.attachments instanceof Set, 'the held path was never bound to the session')
  assert.ok(session.attachments.has(paste.path), 'the session does not own the path it was just sent')

  /* AND THE HOLD IS SPENT. A hold that survived being bound would be a
     standing permit: any later session on the same conversation could send
     that file again without the person pasting it. Asking a DIFFERENT session
     to spend it now must be refused by the ordinary allowlist. */
  fixture.sessions.set('a-later-session', liveSession())
  const code = await refusal(() => fixture.surface.run('agent:send', {
    sessionId: 'a-later-session', holdKey: 'node-7', text: 'two', images: [{ path: paste.path }],
  }, windowPrincipal()))
  assert.equal(code, 'MC_AGENT_ATTACHMENT_UNKNOWN',
    'the hold outlived the send that spent it, so one paste authorises a file for every later session on that conversation')
})

/* THE ROUTE AN ORDINARY PERSON TAKES INTO THAT REFUSAL, AND WHAT THEY THEN READ.
 *
 * The cases above all start from a paste made while NO session was live, which
 * takes the hold branch and is bound at send time. The common case is the other
 * one: the agent IS running when the person pastes, so
 * `'agent:paste-attachment'` takes its `if (session)` branch, puts the path in
 * THAT session's allowlist and -- this is the part that matters -- does NOT
 * also hold it against the conversation. There is no fallback.
 *
 * So anything that REPLACES the session between the paste and the Enter leaves
 * the composer holding a chip whose path belongs to a session that no longer
 * exists and was never held. This build ships at least two such things: the
 * automatic dead-session replacement (`recoverDeadSessionSend` in
 * src/views/computers.js starts a NEW session), and the model switch landed in
 * this same cut as 3eb95f06, whose own message says "the session ends, a fresh
 * one starts on the chosen tier". The owner's two reports on 2026-09-16 were
 * "switch models still doesnt work" at 02:58Z and "sending images doesnt work"
 * at 03:28Z, half an hour apart in the same sitting.
 *
 * THE REFUSAL ITSELF IS CORRECT AND THIS CASE DOES NOT SOFTEN IT: the
 * allowlist is the fence that stops a caller naming an arbitrary disk path for
 * the engine to read. What was wrong was what the person was then told. */
test('a picture pasted into a running agent is refused after the session is replaced, and the composer says so about the picture', async () => {
  const fixture = surfaceFixture()

  /* The agent is running when the person pastes -- the ordinary case. */
  const first = liveSession()
  fixture.sessions.set('session-one', first)
  const paste = await fixture.surface.run('agent:paste-attachment', {
    sessionId: 'session-one', holdKey: 'node-7', mime: 'image/png', data: PNG,
  }, windowPrincipal())
  assert.equal(paste.ok, true, 'a paste into a running agent was refused')
  assert.notEqual(paste.held, true,
    'a paste into a RUNNING session reports itself as held; this case is about the branch that does not hold')
  assert.ok(first.attachments?.has(paste.path), 'the path did not enter the running session\'s own allowlist')

  /* The session is replaced -- a model switch, an account continuation, or the
     automatic replacement of a session the host has rejected. The composer
     keeps its chip either way: pending attachments are the composer's, not the
     session's. */
  fixture.sessions.delete('session-one')
  fixture.sessions.set('session-two', liveSession())

  const code = await refusal(() => fixture.surface.run('agent:send', {
    sessionId: 'session-two', holdKey: 'node-7', text: 'what colour is this?', images: [{ path: paste.path }],
  }, windowPrincipal()))

  assert.equal(code, 'MC_AGENT_ATTACHMENT_UNKNOWN',
    'the replacement session sent a path it never issued, which is the fence the whole attachment allowlist exists to be')
  assert.equal(fixture.sent.length, 0, 'the turn reached the host, so the refusal is not preflight after all')

  /* AND NOW THE HALF THAT WAS THE DEFECT. src/views/computers.js treeCardSend
     turns exactly this code into what the person reads, on both the full tree
     conversation and the right rail. It must be about the picture, and it must
     not claim a delivery nobody can verify -- nothing was written: the
     assertion above proves sendTurn was never called. */
  const sentence = sendRefusalSentence(code)
  assert.notEqual(sentence, sendRefusalSentence('A_CODE_NO_TABLE_IN_THIS_PRODUCT_KNOWS'),
    'the person is told their delivery could not be confirmed, for a turn that never reached the host')
  assert.notEqual(sentence, sendRefusalSentence('MC_AGENT_UNKNOWN_SESSION'),
    'the person is told to check that the agent is still available, which names nothing they can act on')
  assert.equal(sendFailureIsUnconfirmed(code), false,
    'nothing was written and the composer still pauses automatic sending')
})

test('a path nobody ever issued is still refused', async () => {
  const fixture = surfaceFixture()
  fixture.sessions.set('session-now-live', liveSession())
  const code = await refusal(() => fixture.surface.run('agent:send', {
    sessionId: 'session-now-live', holdKey: 'node-7', text: 'x', images: [{ path: 'C:\\somewhere\\else.png' }],
  }, windowPrincipal()))

  assert.equal(code, 'MC_AGENT_ATTACHMENT_UNKNOWN',
    'the attachment allowlist stopped meaning anything: a path the picker never issued was sent')
  assert.equal(fixture.sent.length, 0)
})

test('one owner cannot send another owner\'s held image', async () => {
  const fixture = surfaceFixture()
  const paste = await fixture.surface.run('agent:paste-attachment', {
    sessionId: 'old', holdKey: 'node-7', mime: 'image/png', data: PNG,
  }, windowPrincipal('owner-1'))
  fixture.sessions.set('session-now-live', liveSession('owner-2'))

  const code = await refusal(() => fixture.surface.run('agent:send', {
    sessionId: 'session-now-live', holdKey: 'node-7', text: 'x', images: [{ path: paste.path }],
  }, windowPrincipal('owner-2')))

  assert.equal(code, 'MC_AGENT_ATTACHMENT_UNKNOWN', 'a hold made by one owner was claimed by another')
  assert.equal(fixture.sent.length, 0)
})

test('a paste with no conversation named and no live session is refused exactly as before', async () => {
  const fixture = surfaceFixture()
  const code = await refusal(() => fixture.surface.run('agent:paste-attachment', {
    sessionId: 'session-from-a-previous-run', mime: 'image/png', data: PNG,
  }, windowPrincipal()))

  assert.equal(code, 'MC_AGENT_UNKNOWN_SESSION',
    'the unknown-session refusal was widened away for callers that named no conversation')
  assert.equal(fixture.saved.length, 0, 'a file was written for a paste that names neither a live session nor a conversation')
})

test('a caller that is not the window at the keyboard is refused, held conversation or not', async () => {
  const fixture = surfaceFixture()
  const code = await refusal(() => fixture.surface.run('agent:paste-attachment', {
    sessionId: 'old', holdKey: 'node-7', mime: 'image/png', data: PNG,
  }, relayPrincipal()))

  assert.equal(code, 'MC_AGENT_PASTE_REQUIRES_WINDOW',
    'a caller that is not at this keyboard was allowed to paste, which is exactly what must not widen')
  assert.equal(fixture.saved.length, 0)
})

test('a live owned session still takes the path it always took', async () => {
  const fixture = surfaceFixture()
  const session = liveSession()
  fixture.sessions.set('session-live', session)
  const result = await fixture.surface.run('agent:paste-attachment', {
    sessionId: 'session-live', mime: 'image/png', data: PNG,
  }, windowPrincipal())

  assert.equal(result.ok, true)
  assert.ok(session.attachments instanceof Set && session.attachments.has(result.path),
    'the ordinary paste stopped binding its file to the session')
})
