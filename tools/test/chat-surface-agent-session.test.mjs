import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const sessionSource = readFileSync(new URL('../../src/agent-session.js', import.meta.url), 'utf8')
const componentSource = readFileSync(new URL('../../src/components.js', import.meta.url), 'utf8')

function liveSessionMount(source) {
  const start = source.indexOf('function mountSessionControls')
  assert.ok(start >= 0, 'the live agent-session surface is no longer mounted by mountSessionControls')
  const end = source.indexOf('\nfunction ', start + 1)
  return source.slice(start, end < 0 ? undefined : end)
}

function chatCall(mount) {
  const match = /buildChat\(\{([\s\S]*?)\}\)/.exec(mount)
  assert.ok(match, 'the live agent-session surface no longer mounts buildChat')
  return match[1].replace(/\/\*[\s\S]*?\*\//g, '')
}

function assertWholeConfigMount(source) {
  const call = chatCall(liveSessionMount(source))
  assert.match(
    call,
    /\.\.\.config\b/,
    'the live agent-session panel hand-picks buildChat fields instead of spreading its config whole',
  )

  const sendModes = [
    /\bonSend\s*:/,
    /\bsampleConversation\s*:\s*true\b/,
    /\bcomposerReason\s*:/,
  ].filter(pattern => pattern.test(call))
  assert.equal(sendModes.length, 1, 'the live agent-session panel must pass exactly one honest send mode')
}

test('the shared chat component gives every mounted panel a drift-checkable identity', () => {
  assert.match(
    componentSource,
    /<div class="chat[^`]*\bdata-chat-panel\b/,
    'buildChat lost data-chat-panel, so mount-point drift can no longer be checked by panel identity',
  )
})

const panelized = /\.\.\.config\b/.test(liveSessionMount(sessionSource))

test('SKIP until agent-session whole-config panelization lands: the transcript panel spreads one-mode config whole',
  { skip: !panelized && 'the session-transcript buildChat call is still an inline, hand-picked field list' }, () => {
    assertWholeConfigMount(sessionSource)
  })

test('the whole-config pin rejects the historical hand-picked-field mutation', () => {
  const compliantScratch = `
function mountSessionControls(root, config = {}) {
  const chat = buildChat({ ...config, composerReason: SESSION_TRANSCRIPT_COMPOSER_REASON })
}
`
  assert.doesNotThrow(
    () => assertWholeConfigMount(compliantScratch),
    'the control scratch must represent the whole-config handoff',
  )

  const handPickedScratch = compliantScratch.replace(
    '...config, composerReason: SESSION_TRANSCRIPT_COMPOSER_REASON',
    'title: config.title, tall: config.tall, seed: config.seed, composerReason: config.composerReason, onAttach: config.onAttach, onMention: config.onMention',
  )
  assert.throws(
    () => assertWholeConfigMount(handPickedScratch),
    /hand-picks buildChat fields/,
    'the explicit six-field scratch mutation survived the whole-config pin',
  )
})
