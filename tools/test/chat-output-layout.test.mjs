import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { afterEach } from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { markRoleContext } from '../../src/chat-role-context.js'

installDomStandIn()
const { buildChat } = await import('../../src/components.js')
const mounted = []
const mount = options => {
  const chat = buildChat({ title: 'Controller', seed: 0, onSend() {}, ...options })
  document.body.append(chat)
  mounted.push(chat)
  return chat
}
afterEach(() => { for (const chat of mounted.splice(0)) { chat.dispose(); chat.remove() } })
const introduction = [
  'TOOLSENABLED ROLE DIRECTIONS (configured in the Role library)',
  'Role: Controller', 'Purpose: Coordinate the requested task.', 'Owns: Final verification.',
  'Must not: Claim unmeasured success.', 'Hands off to: Managers for bounded work.', '',
  'Follow these directions while carrying out the person\'s task. They do not grant tools, permissions, or authority beyond this session\'s enforced limits.',
].join('\n')

test('the complete host role envelope is labelled context without rewriting the transcript', () => {
  const original = Object.freeze({ who: 'you', text: introduction, at: 100, turnStamp: 'source-turn' })
  const context = markRoleContext(original, 'session-1')
  assert.equal(context.who, 'context')
  assert.equal(context.text, original.text)
  assert.equal(context.at, 100)
  assert.equal(context.turnStamp, 'source-turn')
  assert.match(context.summary, /Role directions · Controller · \d+ words/)
  assert.equal(original.who, 'you')
  const chat = mount({ history: [{ who: 'you', text: 'My own words' }, context] })
  assert.equal(chat.querySelectorAll('.me').length, 1)
  const disclosure = chat.querySelector('.chat-context')
  assert.equal(disclosure.open, false)
  assert.equal(disclosure.querySelector('.who').textContent, 'Added by ToolsEnabled')
  assert.match(disclosure.querySelector('.chat-context-body').textContent, /Final verification/)
})

test('ordinary asks, incomplete envelopes, and agent quotes retain their actual speaker', () => {
  for (const entry of [
    { who: 'you', text: 'Explain TOOLSENABLED ROLE DIRECTIONS' },
    { who: 'you', text: introduction + '\nNow answer my question.' },
    { who: 'you', text: introduction.replace('Hands off to:', 'A quote:') },
    { who: 'agent', text: introduction },
    { who: 'you', text: null },
  ]) assert.equal(markRoleContext(entry, 'session'), entry)
})

test('context and thinking disclosures keep selectable body text open', () => {
  const chat = mount({ history: [markRoleContext({ who: 'you', text: introduction })] })
  const context = chat.querySelector('.chat-context')
  context.querySelector('summary').click()
  assert.equal(context.open, true)
  context.querySelector('.chat-context-body').click()
  assert.equal(context.open, true, 'pressing/selecting context is not a collapse gesture')
  const thought = chat.addThinking('Working notes supplied by the transcript.')
  assert.equal(thought.tagName, 'DETAILS')
  assert.equal(Boolean(thought.open), false)
  assert.equal(thought.querySelector('summary').textContent, 'Thinking')
  thought.querySelector('summary').click()
  assert.equal(thought.open, true)
  thought.querySelector('.chat-msg-text').click()
  assert.equal(thought.open, true)
})

test('a tool output remains selectable while both its call and run stay open', () => {
  const chat = mount({ history: [
    { who: 'action', id: 'a', tool: 'Read', detail: 'report.txt', body: 'Full measured output', stateKey: 'done' },
    { who: 'action', id: 'b', tool: 'Read', detail: 'second.txt', body: 'Second measured output', stateKey: 'done' },
  ] })
  const run = chat.querySelector('.chat-action-run')
  run.querySelector('summary').click()
  assert.equal(run.open, true)
  const row = run.querySelector('.chat-action-run-body').querySelector('.chat-action')
  row.querySelector('summary').click()
  assert.equal(row.open, true)
  row.querySelector('.chat-action-body').click()
  assert.equal(row.open, true)
  assert.equal(run.open, true)
})

test('restored approvals and turn outcomes remain visible outside the tool-call count', () => {
  const chat = mount({ history: [
    { who: 'action', id: 'approval', tool: 'Approval', detail: 'Permission was refused', stateKey: 'refused' },
    { who: 'action', id: 'outcome', tool: 'Turn', detail: 'Turn stopped before completion.', stateKey: 'undone' },
    { who: 'action', id: 'search', tool: 'Tool', detail: 'tool_search', stateKey: 'done' },
    { who: 'action', id: 'call', tool: 'Tool', detail: 'host.list_processes', stateKey: 'undone' },
  ] })
  const run = chat.querySelector('.chat-action-run')
  assert.equal(run.querySelector('.chat-action-run-body').children.length, 2)
  assert.match(run.querySelector('.chat-action-detail').textContent, /^2 tool calls/)
  for (const word of ['Approval', 'Turn']) {
    const chip = [...chat.querySelectorAll('.chat-action-tool')].find(el => el.textContent === word)
    assert.ok(chip)
    assert.ok(chip.closest('.chat-action-run') === null)
  }
})

test('a typed command approval stays outside the tool-call group despite its command label', () => {
  const chat = mount({ history: [
    { who: 'action', id: 'approval', kind: 'approval', tool: 'Command', detail: 'pwd', stateKey: 'refused' },
    { who: 'action', id: 'call', kind: 'call', tool: 'Command', detail: 'pwd', stateKey: 'refused' },
  ] })
  const rows = [...chat.querySelectorAll('.chat-action-tool')]
  assert.equal(rows.length, 2)
  assert.ok(rows[0].closest('.chat-action-run') === null)
  assert.ok(rows[1].closest('.chat-action-run') !== null)
})

test('workspace metadata starts compact, retains the whole path, and preserves an opened disclosure on refresh', () => {
  let notify
  const full = 'C:\\work\\a-very-long-workspace-name\\engine'
  const chat = mount({ headerMeta: {
    read: () => ({ path: { source: 'session-workspace', value: full } }),
    subscribe: listener => { notify = listener; return () => {} },
  } })
  const workspace = chat.querySelector('.chat-workspace')
  assert.ok(workspace)
  assert.equal(workspace.open, false)
  assert.equal(workspace.querySelector('summary').textContent, 'Workspace · engine')
  assert.equal(workspace.querySelector('[data-chat-header-path]').textContent, full)
  workspace.open = true
  notify()
  assert.equal(chat.querySelector('.chat-workspace').open, true)
  assert.equal(chat.querySelector('[data-chat-header-path]').textContent, full)
})

test('every scrolling transcript row owns its full block height, including the streaming height hold', () => {
  const css = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8')
  assert.match(css, /\.chat-log\s*>\s*\*\s*\{[^}]*flex:\s*none;/)
  assert.match(css, /\.chat-log\s*>\s*\*\s*\{[^}]*min-width:\s*0;/)
  // The real Chromium fixture adds the shrinking rule back as a negative
  // control: it must reproduce the answer/tool overlap before this can pass.
})
