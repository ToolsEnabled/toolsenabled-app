import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

/* THE COMPUTERS RAIL CHAT'S PER-SURFACE CONTRACT.
 *
 * A shared chat config is deliberately wider than any list a mount author is
 * likely to remember.  The compact tree card once copied six fields out of
 * that config and consequently missed every power added in the next
 * iteration.  This pin is local to the computers rail mount: it requires the
 * whole config to cross that boundary and checks the three mutually exclusive
 * composer modes at the config producer, rather than blessing today's field
 * names as a complete list.
 *
 * CHAT_SURFACE_RAIL_CHAT_SOURCE is also intentional.  It lets the mutation
 * proof run this exact suite against a scratch copy of computers.js; no source
 * file in the checkout has to be edited to demonstrate the red result. */

const computersPath = process.env.CHAT_SURFACE_RAIL_CHAT_SOURCE
  || new URL('../../src/views/computers.js', import.meta.url)
const computers = readFileSync(computersPath, 'utf8')
const components = readFileSync(new URL('../../src/components.js', import.meta.url), 'utf8')

const stripComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|\s)\/\/.*$/gm, '$1')

function railMountFrom(source) {
  const start = source.indexOf("const chatHost = controlsPage.querySelector('[data-rail-chat-host]')")
  assert.notEqual(start, -1, 'the computers rail chat mount moved or disappeared')
  const end = source.indexOf('    /* THE KEYBOARD HALF', start)
  assert.notEqual(end, -1, 'the computers rail chat mount no longer has its expected boundary')
  return stripComments(source.slice(start, end))
}

function assertWholeConfigMount(source) {
  const mount = railMountFrom(source)
  assert.ok(/const chat = buildChat\(\{\s*\.\.\.config\s*,/.test(mount),
    'the computers rail chat hand-picked config fields instead of spreading the config whole')
  assert.match(mount, /chatHost\.appendChild\(chat\)/,
    'the computers rail host no longer mounts the panel returned by buildChat')
}

test('computers rail mounts the identity-marked buildChat panel', () => {
  assert.match(components, /<div class="chat[^"\n]*" data-chat-panel(?:\s|>)/,
    'buildChat no longer identity-marks its panel with data-chat-panel')
  assertWholeConfigMount(computers)
})

test('computers rail config supplies exactly one composer mode and is spread whole', () => {
  assertWholeConfigMount(computers)

  const start = computers.indexOf('  function treeChatConfigFor(node) {')
  const end = computers.indexOf('  let chipRefreshFrame', start)
  assert.ok(start >= 0 && end > start, 'treeChatConfigFor moved or disappeared')
  const producer = stripComments(computers.slice(start, end))
  const readOnly = producer.slice(producer.indexOf('if (!node.sessionId) {'), producer.indexOf('    let history =', producer.indexOf('if (!node.sessionId) {')))
  const live = producer.slice(producer.indexOf('    return {', producer.indexOf('    let history =')))

  assert.match(readOnly, /composerReason\s*:/, 'the session-less config has no composerReason')
  assert.doesNotMatch(readOnly, /\bonSend\s*:|sampleConversation\s*:\s*true/,
    'the session-less config supplies more than its one composer mode')
  assert.match(live, /\bonSend\s*:/, 'the session config has no real onSend')
  assert.doesNotMatch(live, /composerReason\s*:|sampleConversation\s*:\s*true/,
    'the session config supplies more than its one composer mode')
})

test('mutation check rejects a hand-picked field list in a scratch copy', () => {
  const scratch = computers.replace('          ...config,', [
    '          title: config.title,',
    '          subtitle: config.subtitle,',
    '          roleKey: config.roleKey,',
    '          history: config.history,',
    '          onSend: config.onSend,',
    '          onAttach: config.onAttach,',
  ].join('\n'))
  assert.ok(scratch !== computers, 'the mutation seam moved; the hand-picked-list proof did not mutate anything')
  assert.throws(() => assertWholeConfigMount(scratch), /hand-picked config fields/,
    'a hand-picked field list survived the rail surface pin')
})
