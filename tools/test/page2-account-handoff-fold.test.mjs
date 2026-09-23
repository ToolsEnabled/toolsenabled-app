import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { functionSource } from './helpers/tree-rail-chat-harness.mjs'

// A conversation continued on another account starts from the product's handoff (up to 48,000
// characters, sent from the person's side), which every chat drew as a wall of text in
// the person's colour. The actual markTreeContext and the actual buildChat: the handoff
// is one folded line, and the whole text is still there, one press away.
const dom = installDomStandIn()
const { buildChat } = await import('../../src/components.js')
const continuation = await import('../../src/manual-account-continuation.js')
const copy = await import('../../src/fleet-tree-copy.js')
const { readTreeAddress } = await import('../../src/tree-node-brief.js')
const { markRoleContext } = await import('../../src/chat-role-context.js')
const require = createRequire(import.meta.url)
const { recoveryHandoff } = require('../../shell/account-session-recovery.cjs')
test.after(() => dom.restore())

const manual = continuation.manualAccountHandoff(
  { sessionId: 'old-session', message: 'Fix the invoice export totals.' },
  { lines: [{ who: 'agent', text: 'I found the rounding bug in totals.js.' }], threadId: 'thread-1', provider: 'codex' }, null)
const automatic = recoveryHandoff({ first: 'Fix the invoice export totals.', segments: ['\n[message]\nWhere are we?', 'Halfway through the fix.'], head: 0 })
// OWNER REQUEST T137: a model switch the thread cannot make in place is the
// same continuation, opened with its own sentence and naming both models.
const model = continuation.manualModelHandoff(
  { sessionId: 'old-session', message: 'Fix the invoice export totals.' },
  { lines: [{ who: 'agent', text: 'I found the rounding bug in totals.js.' }], threadId: 'thread-1', provider: 'claude' }, null,
  { fromLabel: 'Sonnet (claude)', toLabel: 'Luna (codex)' })

const context = vm.createContext({
  isAccountHandoff: continuation.isAccountHandoff, isModelHandoff: continuation.isModelHandoff,
  handoffContextLabel: copy.handoffContextLabel, handoffContextSummary: copy.handoffContextSummary,
  TREE_CONTEXT_LABEL: copy.TREE_CONTEXT_LABEL, treeContextSummary: copy.treeContextSummary,
  readTreeAddress, markRoleContext,
})
vm.runInContext(functionSource('markTreeContext'), context)
const markTreeContext = (history, sessionId) => context.markTreeContext(history, sessionId)

test('all three handoff producers open with a sentence the chat recognises', () => {
  assert.equal(continuation.isAccountHandoff(manual), true, 'the manual continuation handoff')
  assert.equal(continuation.isAccountHandoff(automatic), true, 'the shell automatic recovery handoff (shell/account-session-recovery.cjs)')
  assert.equal(continuation.isAccountHandoff(model), true, 'the model continuation handoff is a handoff too')
  assert.equal(continuation.isModelHandoff(model), true)
  assert.equal(continuation.isModelHandoff(manual), false, 'an account handoff is not mistaken for a model one')
  assert.equal(continuation.isModelHandoff(automatic), false)
  assert.equal(continuation.isAccountHandoff('Please continue with the export.'), false)
  assert.equal(continuation.isAccountHandoff('I will continue the same assigned task in a new session tomorrow.'), false)
})

test('the model handoff names both models and keeps the conversation and the brief', () => {
  assert.match(model, /Previous model: Sonnet \(claude\)\. New model: Luna \(codex\)\./)
  assert.match(model, /Original task: Fix the invoice export totals\./)
  assert.match(model, /I found the rounding bug in totals\.js\./)
  assert.match(model, /Previous native thread: thread-1\. Previous provider: claude\./)
})

for (const [name, text, label, line] of [
  ['manual continuation', manual, copy.HANDOFF_CONTEXT_LABEL, /continued on another account/],
  ['automatic recovery', automatic, copy.HANDOFF_CONTEXT_LABEL, /continued on another account/],
  ['model continuation', model, copy.MODEL_HANDOFF_CONTEXT_LABEL, /continued on another model/],
]) {
  test(`a ${name} handoff is one folded line, not a wall of text in the person's colour`, () => {
    const history = markTreeContext([
      { who: 'you', text, at: 1 },
      { who: 'agent', text: 'Continuing: the totals now round per line.', at: 2 },
      { who: 'you', text: 'Thanks, keep going.', at: 3 },
    ], 'new-session')
    assert.equal(history[0].who, 'context')
    assert.equal(history[0].label, label)
    assert.equal(history[0].openKey, 'new-session:handoff')
    const chat = buildChat({ title: 'Fixture agent', seed: 0, history })
    const mine = chat.querySelectorAll('.msg').filter(row => row.classList.contains('me'))
    assert.equal(mine.length, 1, 'only the person\'s own message wears their colour')
    assert.match(mine[0].textContent, /Thanks, keep going\./)
    const folds = chat.querySelectorAll('.chat-context')
    assert.equal(folds.length, 1, 'the handoff is one fold')
    const foldLine = folds[0].querySelector('.chat-context-line').textContent
    assert.match(foldLine, line)
    assert.match(foldLine, /\d+ words/)
    assert.equal(folds[0].open, false, 'folded shut by default')
    assert.ok(folds[0].querySelector('.chat-context-body').textContent.length > 200, 'the whole handoff is still inside')
  })
}

test('an ordinary first message is untouched', () => {
  const history = markTreeContext([{ who: 'you', text: 'Continue with the export, please.', at: 1 }], 's')
  assert.deepEqual(history, [{ who: 'you', text: 'Continue with the export, please.', at: 1 }])
})
