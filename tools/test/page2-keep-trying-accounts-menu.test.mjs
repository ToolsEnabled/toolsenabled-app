import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import test from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'

// Stored retry policies must not bring automatic account controls back into chat.
// Account choice is explicit; the real account picker has its own DOM tests.
const dom = installDomStandIn()
const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
const { buildChat } = await import('../../src/components.js')
const { movedOffParagraph } = await import('../../src/account-switcher-state.js')
test.after(() => {
  dom.restore()
  if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor)
  else delete globalThis.crypto
})

for (const value of ['off', 'keep', 'wait']) test('a stored ' + value + ' retry policy offers no automatic account action', () => {
  const changes = [], retries = []
  const root = buildChat({ title: 'Fixture agent', seed: 0, onSend() {}, chips: {
    model: () => ({ label: 'Fixture model' }), onOpenModel() {},
    accountRetry: () => ({ value, status: 'Fixture saved retry status', showAction: true, actionDisabled: false }),
    onAccountRetryChange: next => changes.push(next),
    onAccountRetryNow: () => retries.push(true),
  } })
  document.body.append(root)
  assert.equal(root.querySelector('[data-chat-chip="account-retry"]'), null)
  assert.equal(root.querySelector('[data-chat-chip="account-retry-now"]'), null)
  assert.doesNotMatch(root.textContent, /Keep trying accounts|Try accounts now|Wait for resets|Fixture saved retry status/)
  assert.deepEqual(changes, [])
  assert.deepEqual(retries, [])
  assert.ok(root.querySelector('[data-chat-chip="model"]'))
  root.dispose?.(); root.remove()
})

test('a previously reported different account asks for an explicit choice', () => {
  const text = movedOffParagraph({ movedOffByProvider: { claude: { chosen: 'Chosen account', using: 'Reported account' } } })
  assert.match(text, /Chosen account/)
  assert.match(text, /Reported account/)
  assert.match(text, /choose.*before continuing/i)
  assert.doesNotMatch(text, /return.*automatically|switch.*automatically|as soon as/i)
})
