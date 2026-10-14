// REPORT-C4-surface-rail-chat-tab.md
//
// The computers rail Chat tab is a distinct chat mount, so this pin identifies
// it by its own host and follows the value returned by buildChat to the append.
// It also checks the component's data-chat-panel identity: without that
// identity there is no surface-independent way for drift checks to count the
// panel. The config is deliberately treated as an opaque contract. In
// particular, enumerating today's fields is not evidence that tomorrow's field
// reaches the rail; only spreading the complete config is.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const COMPUTERS = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
const COMPONENTS = readFileSync(new URL('../../src/components.js', import.meta.url), 'utf8')

const codeOnly = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '')

function railChatTab(source) {
  const start = source.indexOf("const chatHost = controlsPage.querySelector('[data-rail-chat-host]')")
  assert.notEqual(start, -1, 'the computers rail lost its identity-marked Chat-tab host')
  const end = source.indexOf('/* THE KEYBOARD HALF', start)
  assert.notEqual(end, -1, 'the rail Chat-tab mount moved beyond its pinned boundary')
  return codeOnly(source.slice(start, end))
}

function assertWholeConfigMount(source) {
  const mount = railChatTab(source)
  assert.match(mount, /const chat = buildChat\(\{\s*\.\.\.config,/,
    'the rail Chat tab must spread the entire shared config into buildChat')
  assert.match(mount, /chatHost\.appendChild\(chat\)/,
    'the rail Chat tab must append the panel returned by buildChat')
}

test('the computers rail Chat tab mounts the identity-marked buildChat panel', () => {
  assert.match(codeOnly(COMPONENTS), /<div class="chat\$\{[^\n]+\}" data-chat-panel\b/,
    'buildChat lost data-chat-panel, so this mount has no stable panel identity')
  assertWholeConfigMount(COMPUTERS)
})

test('the rail passes its config whole, not a hand-picked field list', () => {
  assertWholeConfigMount(COMPUTERS)

  /* Mutation check, performed on a scratch string rather than the worktree.
     This is the historical failure shape: today's remembered fields pass,
     while the next option added to treeChatConfigFor silently starves here. */
  const mutant = COMPUTERS.replace('...config,\n          tall: true,', [
    'title: config.title,',
    '          subtitle: config.subtitle,',
    '          roleKey: config.roleKey,',
    '          history: config.history,',
    '          seed: config.seed,',
    '          onSend: config.onSend,',
    '          tall: true,',
  ].join('\n          '))
  assert.notEqual(mutant, COMPUTERS, 'the scratch mutation no longer reaches the rail call')
  assert.throws(() => assertWholeConfigMount(mutant), /spread the entire shared config/,
    'the pin stayed green after replacing the spread with a hand-picked list')
})

test('every rail config carries exactly one honest composer mode', () => {
  const start = COMPUTERS.indexOf('function treeChatConfigFor(node) {')
  const end = COMPUTERS.indexOf('let chipRefreshFrame', start)
  assert.ok(start >= 0 && end > start, 'treeChatConfigFor moved beyond its pinned boundary')
  const config = codeOnly(COMPUTERS.slice(start, end))
  const noSession = config.slice(config.indexOf('if (!node.sessionId) {'), config.indexOf('let history = sessionTranscripts'))
  const liveStart = config.indexOf('\n    return {', config.indexOf('let history = sessionTranscripts'))
  assert.notEqual(liveStart, -1, 'the session-backed tree chat config lost its return object')
  const live = config.slice(liveStart)

  const composerModes = branch => [
    /\bonSend\s*:/.test(branch),
    /\bsampleConversation\s*:\s*true\b/.test(branch),
    /\bcomposerReason\s*:/.test(branch),
  ].filter(Boolean).length

  assert.equal(composerModes(noSession), 1,
    'the session-less rail config must carry composerReason, and no sending or simulation mode')
  assert.equal(composerModes(live), 1,
    'the session-backed rail config must carry onSend, and no refusal or simulation mode')

  const mount = railChatTab(COMPUTERS)
  assert.doesNotMatch(mount, /\bsampleConversation\s*:\s*true\b/,
    'the real computers rail must never opt into the demonstration conversation')
})
