import assert from 'node:assert/strict'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const moduleUrl = process.env.DOM_STAND_IN_MODULE
  ? pathToFileURL(process.env.DOM_STAND_IN_MODULE).href
  : new URL('./lib/dom-stand-in.mjs', import.meta.url).href
const { installDomStandIn } = await import(moduleUrl)
const { document, restore } = installDomStandIn(globalThis)

let chat
test.after(() => {
  chat?.dispose()
  restore()
})

const { buildChat } = await import('../../src/components.js')
const { approvalDecisionWord } = await import('../../src/fleet-tree-copy.js')
const { NO_SENDER_WIRED } = await import('../../src/chat-copy.js')
const { sessionActivityEvent } = await import('../../src/agent-session-events.js')
const DECLINE_WORD = approvalDecisionWord('decline')
const ACCEPT_WORD = approvalDecisionWord('accept')

const decisions = []
chat = buildChat({
  title: '·',
  seed: 0,
  history: [],
  composerReason: NO_SENDER_WIRED,
  onApprovalDecision: async (id, decision) => { decisions.push({ id, decision }); return null },
})
document.documentElement.appendChild(chat)

test('approval is an inline transcript row carrying the shipped decision words, never a modal', async () => {
  assert.equal(typeof chat.showApproval, 'function', 'buildChat no longer exposes showApproval, so approvals cannot render as transcript rows')
  chat.showApproval({ id: 'approval-17', summary: '·', decisions: ['decline', 'accept'], badges: ['·'] })

  const log = chat.querySelector('.chat-log')
  const row = [...log.children].find(candidate => candidate.textContent.includes('·'))
  assert.ok(row, 'the approval was not appended to the transcript')
  assert.equal(row.parentNode, log, 'the approval escaped the transcript into another surface')
  assert.equal(chat.querySelector('[role="dialog"]'), null, 'the approval rendered as a modal dialog')
  assert.equal(document.body.querySelector('[role="dialog"]'), null, 'the approval rendered in a page-level modal dialog')

  const buttons = row.querySelectorAll('button')
  assert.ok(DECLINE_WORD && ACCEPT_WORD && DECLINE_WORD !== ACCEPT_WORD,
    `the approval vocabulary no longer supplies two distinct words: ${JSON.stringify([DECLINE_WORD, ACCEPT_WORD])}`)
  assert.deepEqual(buttons.map(button => button.textContent), [DECLINE_WORD, ACCEPT_WORD],
    'the strip\'s buttons are not the source-owned decline and accept words in order')
  buttons[1].dispatch('click')
  await Promise.resolve()
  assert.deepEqual(decisions, [{ id: 'approval-17', decision: 'accept' }])
})

const grokOptions = [
  { optionId: 'always-allow', name: 'always allow', kind: 'allow_always' },
  { optionId: 'allow-once', name: 'allow once', kind: 'allow_once' },
  { optionId: 'reject-once', name: 'reject once', kind: 'reject_once' },
]

test('native ACP options survive the event reader and an actual chat click without changing scope', async () => {
  const activity = sessionActivityEvent({ sessionId: 'native-grok', event: {
    type: 'approval_request', approval: { approvalId: 'native-options', kind: 'tool_permission',
      availableDecisions: grokOptions, details: { toolCall: { title: 'host.list_processes' } } },
  } }, 'native-grok')
  const calls = []
  const panel = buildChat({ title: '·', seed: 0, history: [], composerReason: NO_SENDER_WIRED,
    onApprovalDecision: async (id, decision) => { calls.push([id, decision]) } })
  try {
    panel.showApproval({ id: activity.approvalId, summary: 'host.list_processes',
      decisions: activity.availableDecisions, decisionKinds: activity.decisionKinds })
    const buttons = panel.querySelectorAll('[data-chat-approval]')
    assert.deepEqual(buttons.map(button => button.textContent),
      ['Always allow', 'Allow once', 'Refuse'])
    assert.equal(buttons[0].classList.contains('chat-approval-accept'), false, 'remembered approval must not be the primary action')
    assert.equal(buttons[1].classList.contains('chat-approval-accept'), true)
    assert.deepEqual(buttons.map(button => button.getAttribute('data-chat-approval')),
      ['always-allow', 'allow-once', 'reject-once'])
    buttons[1].dispatch('click')
    buttons[0].dispatch('click')
    panel.showApproval({ id: activity.approvalId, decisions: activity.availableDecisions, decisionKinds: activity.decisionKinds })
    assert(buttons.every(button => button.disabled), 'repaint must not unlock an in-flight decision')
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(calls, [['native-options', 'allow-once']])
    panel.resolveApproval(activity.approvalId)
    buttons[2].dispatch('click')
    await Promise.resolve()
    assert.equal(calls.length, 1, 'detached buttons must not submit another answer')
  } finally { panel.dispose() }
})

test('an absent or unsupported offered choice cannot invent Allow once', () => {
  const panel = buildChat({ title: '·', seed: 0, history: [], onApprovalDecision: async () => {} })
  try {
    for (const decisions of [undefined, [], ['applyNetworkPolicyAmendment']]) {
      panel.showApproval({ id: 'no-supported-choice', decisions })
      assert.equal(panel.querySelectorAll('[data-chat-approval]').length, 0)
      assert.match(panel.querySelector('.chat-approval-actions').textContent, /Stop the turn/)
    }
  } finally { panel.dispose() }
})

test('a refreshed choice invalidates the old detached button', async () => {
  const calls = []
  const panel = buildChat({ title: '·', seed: 0, history: [], onApprovalDecision: async (...args) => calls.push(args) })
  try {
    panel.showApproval({ id: 'repaint', decisions: ['accept'] })
    const previous = panel.querySelector('[data-chat-approval]')
    panel.showApproval({ id: 'repaint', decisions: ['decline'] })
    previous.dispatch('click')
    await Promise.resolve()
    assert.deepEqual(calls, [])
    panel.querySelector('[data-chat-approval]').dispatch('click')
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(calls, [['repaint', 'decline']])
  } finally { panel.dispose() }
})
