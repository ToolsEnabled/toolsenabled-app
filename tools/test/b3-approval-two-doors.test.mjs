import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { answerWithinBound, createPendingApprovals } from '../../src/approval-answer.js'
import { APPROVAL_PANEL, TURN_CANCELLED, approvalCardChoices, approvalDecisionWord, approvalAnswerSentence, approvalDecisionIsReject } from '../../src/fleet-tree-copy.js'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'
import { installDomStandIn } from './lib/dom-stand-in.mjs'

/* TWO DOORS, ONE STATE: a pending approval reaches every registered chat
 * panel (not only the rail card), and answering at EITHER door settles both.
 *
 * Wired to B1's landed contract for buildChat's mounted root (SendMessage,
 * 2026-08-28): showApproval({id, summary, badges}) / resolveApproval(id) /
 * config.onApprovalDecision(id, decision) => sentence|Promise<sentence>,
 * REJECTED (not resolved) on failure so the component's own retry UX
 * re-enables both buttons — B3's amendment, accepted by B1 the same day.
 * Feature-detected on each registered chat surface so this plumbing is inert
 * against a surface that predates the API, never a hard dependency on it.
 *
 * Source-pinned against src/views/computers.js — see tools/test/session-
 * reply-paths.test.mjs for the same idiom applied to the rail card this
 * plumbing sits beside. */

const VIEW = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')

// Run the real rail, chat and answer handlers together; only DOM and IPC are
// fixtures. Repaints and cross-door presses must not produce another grant.
async function approvalFixture(t) {
  const world = installDomStandIn()
  const { buildChat, controlState } = await import('../../src/components.js')
  const controlsPage = document.createElement('div')
  controlsPage.innerHTML = '<div data-tree-activity></div>'
  document.body.appendChild(controlsPage)
  const pending = createPendingApprovals(), calls = [], replies = []
  const context = vm.createContext({ document, controlsPage, sessionPendingApprovals: pending,
    currentRailTreeNode: { id: 'node' }, sessionNodeIds: new Map([['session', 'node']]),
    APPROVAL_PANEL, TURN_CANCELLED, approvalCardChoices, approvalDecisionWord, approvalAnswerSentence, approvalDecisionIsReject, controlState, answerWithinBound,
    sessionActions: new Map(), confirmedRefusals: new Map(), sessionOpenTurns: new Map(), treeStore: null,
    escapeMarkup: value => String(value), approvalSummary: value => value.approvalId,
    setOrgStatus() {}, chatSurfacesFor: () => [chat],
    window: { mcAgent: { answerApproval: value => { calls.push(value); return new Promise(resolve => replies.push(resolve)) } } } })
  const names = ['pushInlineApproval', 'clearInlineApproval', 'clearSessionApprovals', 'finishApprovalSettle', 'applyAnsweredApprovalRow', 'settleApproval', 'renderApprovalCard']
  vm.runInContext(names.map(name => declaredFunctionSource(VIEW, name)).join('\n'), context)
  const chat = buildChat({ title: 'Approval fixture', onApprovalDecision: async (id, decision) => {
    const result = await context.settleApproval('session', id, decision)
    if (!result.ok) throw Error(result.sentence)
    return result.sentence
  } })
  document.body.appendChild(chat)
  t.after(() => { chat.dispose(); chat.remove(); controlsPage.remove(); for (const resolve of replies) resolve(null); world.restore() })
  const add = id => { pending.set('session', { approvalId: id, availableDecisions: ['allow-once', 'refuse'],
    decisionKinds: { 'allow-once': 'allow_once', refuse: 'reject_once' } }); paint() }
  const paint = () => { context.renderApprovalCard('session', pending.get('session')); context.pushInlineApproval('session') }
  const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
  const rail = () => controlsPage.querySelectorAll('[data-approval-decision]')
  return { pending, calls, replies, context, controlsPage, chat, add, paint, settle, rail }
}

test('rail repaint and another chat surface keep the same in-flight answer locked', async t => {
  const f = await approvalFixture(t)
  f.add('first')
  f.rail()[0].click()
  f.add('second')
  assert(f.rail().every(button => button.disabled), 'a second request must not unlock the first answer')
  assert.match(f.controlsPage.textContent, /2 permissions waiting/)
  const inline = f.chat.querySelectorAll('[data-chat-approval]')
  assert(inline.slice(0, 2).every(button => button.disabled), 'the other door must show the same lock')
  f.rail()[1].dispatch('click')
  inline[0].dispatch('click')
  await f.settle()
  assert.equal(f.calls.length, 1)
  f.replies[0]({ ok: true }); await f.settle()
  assert.equal(f.pending.get('session').approvalId, 'second')
  assert(f.rail().every(button => !button.disabled))
})

test('a failed rail answer unlocks the repainted current card and a detached choice cannot answer', async t => {
  const f = await approvalFixture(t)
  f.add('first')
  const detached = f.rail()[0]
  detached.click()
  f.paint()
  f.replies[0](null); await f.settle()
  assert(f.rail().every(button => !button.disabled))
  assert.match(f.controlsPage.textContent, /answer did not land/i)
  detached.dispatch('click'); await f.settle()
  assert.equal(f.calls.length, 1)
  f.rail()[1].click(); await f.settle()
  assert.equal(f.calls.length, 2)
})

test('an inline answer locks the rail across a late settlement of another permission', async t => {
  const f = await approvalFixture(t)
  f.add('first')
  f.chat.querySelector('[data-chat-approval]').click()
  await f.settle()
  f.context.finishApprovalSettle('session', 'already-gone')
  assert(f.rail().every(button => button.disabled))
  f.rail()[1].dispatch('click'); await f.settle()
  assert.equal(f.calls.length, 1)
  f.replies[0]({ ok: true }); await f.settle()
  assert.equal(f.pending.all('session').length, 0)
  assert.equal(f.controlsPage.querySelector('[data-tree-approval]'), null)
})

test('a late answer and a cancelled snapshot cannot settle a later request that reuses its id', async t => {
  const f = await approvalFixture(t)
  f.add('first')
  const snapshot = f.pending.all('session')
  f.rail()[0].click()
  f.context.clearSessionApprovals('session')
  f.add('first')
  f.context.clearSessionApprovals('session', snapshot)
  f.replies[0]({ ok: true }); await f.settle()
  assert.equal(f.pending.all('session').length, 1)
  assert(f.rail().every(button => !button.disabled))
  assert.equal(f.chat.querySelectorAll('[data-chat-approval]').length, 2)
})

test('an unconfirmed answer after completion does not claim the agent is still waiting', async t => {
  const f = await approvalFixture(t)
  f.add('first')
  const answer = f.context.settleApproval('session', 'first', 'refuse')
  f.context.clearSessionApprovals('session')
  f.replies[0](null)
  const result = await answer
  assert.equal(result.ok, false)
  assert.equal(result.sentence, APPROVAL_PANEL.ended)
  assert.equal(f.pending.all('session').length, 0)
})

test('a pending approval is pushed to every registered chat surface, not only the rail card', () => {
  const activityBranch = VIEW.slice(VIEW.indexOf("if (activity.kind === 'approval' && activity.approvalId)"), VIEW.indexOf("if (activity.kind === 'approval' && activity.approvalId)") + 1400)
  assert.match(activityBranch, /sessionPendingApprovals\.set\(sessionId,/,
    'the approval is no longer remembered in sessionPendingApprovals — a panel that opens later would offer nothing')
  assert.match(activityBranch, /pushInlineApproval\(sessionId, activity\)/,
    'the activity branch no longer pushes to registered chat surfaces — only the rail card would ever show the question')
})

test('pushInlineApproval carries the actual choices and scopes to every chat surface', () => {
  const pending = createPendingApprovals()
  const approval = { approvalId: 'native', summary: 'host.list_processes',
    availableDecisions: ['allow-once', 'always-allow'], decisionKinds: { 'allow-once': 'allow_once', 'always-allow': 'allow_always' } }
  pending.set('session', approval)
  const calls = []
  const context = vm.createContext({ sessionPendingApprovals: pending,
    chatSurfacesFor: () => [{ showApproval: value => calls.push(value) }, { showApproval: value => calls.push(value) }],
    approvalSummary: value => value.summary })
  vm.runInContext(declaredFunctionSource(VIEW, 'pushInlineApproval'), context)
  context.pushInlineApproval('session', approval)
  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.equal(call.id, 'native')
    assert.equal(call.summary, 'host.list_processes')
    assert.deepEqual(call.decisions, approval.availableDecisions)
    assert.deepEqual(call.decisionKinds, approval.decisionKinds)
  }
})

test('clearInlineApproval resolves the strip on every registered surface by id', () => {
  const fn = VIEW.slice(VIEW.indexOf('function clearInlineApproval'), VIEW.indexOf('function settleApproval') > -1 ? VIEW.indexOf('function settleApproval') : VIEW.indexOf('function renderApprovalCard'))
  assert.match(fn, /typeof root\.resolveApproval !== 'function'/, 'the adapter no longer feature-detects resolveApproval')
  assert.match(fn, /root\.resolveApproval\(approvalId\)/, 'clearInlineApproval no longer calls resolveApproval(id) — an answered question would keep showing on other panels')
})

test('answering at the rail card uses the same pending answer owner as inline chat', () => {
  const card = VIEW.slice(VIEW.indexOf('function renderApprovalCard'), VIEW.indexOf('/* ---- STANDING REQUESTS'))
  assert.match(card, /settleApproval\(sessionId, approval\.approvalId, decision\)/)
})

test('answering inline (onApprovalDecision) reaches the same engine call, the same cleanup, and REJECTS on failure', () => {
  const fn = VIEW.slice(VIEW.indexOf('async function settleApproval'), VIEW.indexOf('function renderApprovalCard'))
  assert.match(fn, /bridge\?\.answerApproval\?\.\(\{ sessionId, approvalId, decision \}\)/,
    'settleApproval no longer answers through the channel — the inline door would appear to work but never reach the engine')
  assert.match(fn, /finishApprovalSettle\(sessionId, approvalId, sentence\)/,
    'settleApproval no longer calls the shared cleanup — the rail card would be left standing after an inline decide')
  const cfg = VIEW.slice(VIEW.indexOf('function treeChatConfigFor'), VIEW.indexOf('function chatActionRowsFor'))
  assert.match(cfg, /onApprovalDecision: \(id, decision\) => \{/,
    'treeChatConfigFor no longer supplies onApprovalDecision — buildChat has nowhere real to route an inline decision')
  const handler = cfg.slice(cfg.indexOf('onApprovalDecision: (id, decision) => {'), cfg.indexOf('chips: {'))
  assert.match(handler, /return settleApproval\(liveSessionId, id, decision\)\.then\(result => \{/,
    'onApprovalDecision no longer routes through settleApproval')
  assert.match(handler, /if \(!result\.ok\) throw new Error\(result\.sentence\)/,
    'onApprovalDecision no longer throws on failure — per B1\'s contract a resolved (non-rejected) promise reads as SUCCESS, so a failed engine answer would leave both buttons stuck disabled with no retry')
})

test('a panel that mounts AFTER the question already fired still gets it', () => {
  const calls = [], approval = { approvalId: 'owned-question', summary: 'An existing question.' }
  const pending = createPendingApprovals(); pending.set('owned-session', approval)
  const context = vm.createContext({ chatSurfaceSessions: new Map(), chatSurfaces: new Map(), chatSpeech: new Map(), chatSpeechMounts: new WeakMap(),
    queueMicrotask: () => {},
    sessionTurnText: new Map(), sessionOpenTurns: new Map(), sessionPendingApprovals: pending, approvalSummary: value => value.summary })
  vm.runInContext(['chatSurfacesFor', 'pushInlineApproval', 'registerChatSurface'].map(name => declaredFunctionSource(VIEW, name)).join('\n'), context)
  const panel = name => ({ isConnected: true, showApproval: value => calls.push([name, value.id, value.summary, [...value.badges]]) })
  context.registerChatSurface('owned-session', panel('first'))
  assert.deepEqual(calls, [['first', 'owned-question', 'An existing question.', []]],
    'The newly mounted panel must receive the question that was already pending')
  calls.length = 0
  context.registerChatSurface('owned-session', panel('second'))
  assert.deepEqual(calls, [['first', 'owned-question', 'An existing question.', []], ['second', 'owned-question', 'An existing question.', []]])
  pending.delete('owned-session'); calls.length = 0
  context.registerChatSurface('owned-session', panel('after-answer'))
  assert.deepEqual(calls, [], 'A panel mounted after the answer must not resurrect the old question')
})

test('a dead turn clears the inline strip too, not only the rail card', () => {
  const completion = VIEW.slice(VIEW.indexOf('const endedApprovalId'), VIEW.indexOf('const endedApprovalId') + 400)
  assert.match(completion, /const endedApprovalId = sessionPendingApprovals\.get\(sessionId\)\?\.approvalId \|\| null/,
    'the completion branch no longer captures the approval id before forgetting the pending question')
  assert.match(completion, /clearInlineApproval\(sessionId, endedApprovalId\)/,
    'a turn that ends without an answer no longer clears the inline strip — a ghost Approve button could survive on a registered panel')
})

test('the actual settle path retains other requests and a late answer cannot erase the next turn', () => {
  const pending = createPendingApprovals()
  pending.set('session', { approvalId: 'first' })
  pending.set('session', { approvalId: 'second' })
  const rendered = [], cleared = []
  let removed = 0
  const context = vm.createContext({ sessionPendingApprovals: pending,
    currentRailTreeNode: { id: 'node' }, sessionNodeIds: new Map([['session', 'node']]),
    controlsPage: { querySelector: () => ({ remove() { removed++ } }) },
    renderApprovalCard: (session, approval) => rendered.push(approval.approvalId),
    clearInlineApproval: (session, id) => cleared.push(id), setOrgStatus() {}, APPROVAL_PANEL })
  vm.runInContext(['finishApprovalSettle', 'clearSessionApprovals'].map(name => declaredFunctionSource(VIEW, name)).join('\n'), context)
  context.finishApprovalSettle('session', 'second')
  assert.equal(pending.get('session').approvalId, 'first')
  assert.deepEqual(rendered, ['first'])
  assert.deepEqual(cleared, ['second'])
  assert.equal(removed, 0)
  context.clearSessionApprovals('session')
  assert.equal(pending.get('session'), undefined)
  assert.deepEqual(cleared, ['second', 'first'])
  pending.set('session', { approvalId: 'next-turn' })
  context.finishApprovalSettle('session', 'first')
  assert.equal(pending.get('session').approvalId, 'next-turn')
  assert.deepEqual(rendered, ['first', 'next-turn'])
  assert.equal(removed, 1, 'cancelling the first turn removes its own card')
})
