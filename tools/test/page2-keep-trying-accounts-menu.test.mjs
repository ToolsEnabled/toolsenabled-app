import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { functionSource } from './helpers/tree-rail-chat-harness.mjs'

// Person's T844 wording: "The Keep trying accounts control got removed from where
// the person used it and was supposed to be replaced with a drop-down bar." The
// select belongs beside model/effort/mode in the open-agent chat bar; the Accounts
// menu keeps the existing Try accounts now action and status for the same node.
// T1027 follows the person's report that redundant Keep trying prose breaks the
// chat layout. The same off/keep/wait policy now has compact visible choices.
const dom = installDomStandIn()
const { el, buildChat } = await import('../../src/components.js')
const { defaultRetryProviders } = await import('../../src/manual-account-continuation.js')
test.after(() => dom.restore())

test('the open-agent chat bar carries the requested retry select beside model/effort/mode', () => {
  const rail = functionSource('showTreeNodeControls')
  const config = functionSource('treeChatConfigFor')
  assert.match(config, /accountRetry/)
  assert.match(config, /onAccountRetryChange/)
  assert.match(config, /onAccountRetryNow/)
  const root = buildChat({ title: 'Builder 4', seed: 0, onSend() {}, chips: {
    onOpenMode() {},
    onOpenEffort() {},
    model: () => ({ label: 'Model' }),
    onOpenModel() {},
    accountRetry: () => ({ value: 'wait', status: 'Waiting for allowance to reset.', showAction: true, actionDisabled: false }),
  } })
  const leftChipNames = [...root.querySelectorAll('.chat-chips-left [data-chat-chip]')].map(chip => chip.dataset.chatChip)
  assert.deepEqual(leftChipNames.slice(0, 4), ['mode', 'effort', 'model', 'account-retry'])
  const select = root.querySelector('[data-chat-chip="account-retry"]')
  assert.ok(select, 'the real chat component must mount a keyboard-reachable select')
  assert.deepEqual([...select.querySelectorAll('option')].map(option => [option.value, option.textContent]), [
    ['off', 'Retries off'], ['keep', 'Retry accounts'], ['wait', 'Wait for resets'],
  ])
  assert.equal(select.value, 'wait')
  assert.equal(root.querySelector('[data-chat-chip="account-retry-now"]').textContent, 'Try accounts now')
  assert.equal(root.querySelector('[data-chat-chip="account-retry-status"]').textContent, 'Waiting for allowance to reset.')
  root.dispose?.()
  assert.doesNotMatch(rail, /data-keep-trying-accounts|data-wait-account-resets/)
  assert.match(rail, /mountAccountRetryControls\(node\)/, 'the controls are still wired for the agent the rail opens')
})

test('the controls find their host in the Accounts menu, and the rail releasing an agent removes them', () => {
  for (const name of ['paintAccountRetryControls', 'mountAccountRetryControls']) {
    const body = functionSource(name)
    assert.doesNotMatch(body, /controlsPage\.querySelector\('\[data-account-retry-controls\]'\)/, `${name} must not look under the chat`)
  }
  assert.match(functionSource('accountRetryHost'), /accountsMenuEl\?\.querySelector\('\[data-account-retry-controls\]'\)/)
  assert.match(functionSource('disposeRailChat'), /removeAccountRetrySection\(\)/)
})

test('the Accounts menu gains one Keep trying section, first in its settings column, for the open agent', () => {
  const menu = el(`<div class="acct-switch"><div class="acct-menu"><div class="acct-workspace"><section class="acct-section acct-listing"></section>
    <div class="acct-sidebar"><section class="acct-section acct-mode"></section><details class="acct-section acct-add"></details></div></div></div></div>`)
  const context = vm.createContext({
    el, defaultRetryProviders, accountsMenuEl: menu,
    escapeMarkup: value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    treeNodeName: node => node.name,
    LAUNCH_TIERS: [{ id: 'fixture-tier', provider: 'claude', label: 'Fixture tier' }],
  })
  vm.runInContext(`${functionSource('accountRetryHost')}\n${functionSource('removeAccountRetrySection')}\n${functionSource('accountRetrySection')}`, context)
  const section = context.accountRetrySection({ id: 'n1', name: 'Builder 3', tier: 'fixture-tier' })
  const sidebar = menu.querySelector('.acct-sidebar')
  assert.equal(sidebar.children[0], section, 'first in the settings column')
  assert.match(section.querySelector('.acct-section-title').textContent, /Keep trying · Builder 3/)
  assert.ok(section.querySelector('[data-keep-trying-accounts]'), 'Keep trying accounts')
  assert.ok(section.querySelector('[data-wait-account-resets]'), 'Wait for resets and auto retry')
  assert.ok(section.querySelector('[data-cancel-account-retries]'))
  assert.ok(section.querySelector('[data-account-retry-status]'))
  assert.equal(section.querySelectorAll('[data-retry-provider]').length, 4)
  context.accountRetrySection({ id: 'n2', name: 'Controller', tier: 'fixture-tier' })
  assert.equal(menu.querySelectorAll('[data-account-retry-controls]').length, 1, 'one agent at a time, never two sections')
  assert.match(menu.querySelector('.acct-section-title').textContent, /Controller/)
  context.removeAccountRetrySection()
  assert.equal(menu.querySelectorAll('[data-account-retry-controls]').length, 0)
})
