import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  activeRouteDescendantExpression,
  activeRouteExpression,
  activeRouteStateExpression,
  pressForwardToActiveRoute,
} from '../lib/active-route-navigation.mjs'

function domNode({ connected = true, inert = false, ariaHidden = false, hidden = false, descendants = {} } = {}) {
  return {
    isConnected: connected,
    hidden,
    closest(selector) {
      if (inert && selector.includes('[inert]')) return this
      if (ariaHidden && selector.includes('[aria-hidden="true"]')) return this
      return null
    },
    querySelectorAll(selector) { return descendants[selector] || [] },
  }
}

function evaluateDomExpression(expression, { hash = '#/computers', route = 'computers', pages = [] } = {}) {
  const location = { hash }
  const document = {
    body: { dataset: { route } },
    querySelectorAll(selector) { return selector === '.computers' ? pages : [] },
  }
  return Function('location', 'document', `return ${expression}`)(location, document)
}

function laggingWindow(states) {
  const queue = [...states]
  let current = queue.shift()
  const clicks = []
  return {
    clicks,
    async evaluate() {
      const answer = current
      if (queue.length > 0) current = queue.shift()
      return answer
    },
    async clickVisible(selector) {
      clicks.push(selector)
      return 'clicked'
    },
  }
}

test('the forward driver stops pressing at the target hash while route paint catches up', async () => {
  const window = laggingWindow([
    { hash: '#/metrics', route: 'metrics', pageActive: false, inert: false },
    /* Immediate navigation has arrived. The old body-route-only loop pressed
       again here and advanced to the page after Computers. */
    { hash: '#/computers', route: 'metrics', pageActive: false, inert: false },
    { hash: '#/computers', route: 'computers', pageActive: true, inert: false },
  ])

  const result = await pressForwardToActiveRoute(window, {
    hash: '#/computers', route: 'computers', pageSelector: '.computers',
    pause: async () => {}, pollMs: 0,
  })

  assert.equal(result.ok, true)
  assert.deepEqual(window.clicks, ['#nav-next'], 'a second press overshot the target hash')
  assert.equal(result.state.route, 'computers')
  assert.equal(result.state.pageActive, true)
})

test('a matching route stamp is not enough until the target page is active and non-inert', async () => {
  const window = laggingWindow([
    { hash: '#/computers', route: 'computers', pageActive: false, inert: true },
    { hash: '#/computers', route: 'computers', pageActive: true, inert: false },
  ])
  const result = await pressForwardToActiveRoute(window, {
    hash: '#/computers', route: 'computers', pageSelector: '.computers',
    pause: async () => {}, pollMs: 0,
  })
  assert.equal(result.ok, true)
  assert.deepEqual(window.clicks, [])
})

test('active route expressions skip a retiring first match and select the active later match', () => {
  const retiring = domNode({ inert: true })
  const current = domNode()
  const options = { hash: '#/computers', route: 'computers', pageSelector: '.computers' }
  const state = evaluateDomExpression(activeRouteStateExpression(options), { pages: [retiring, current] })

  assert.equal(state.matchCount, 2)
  assert.equal(state.activeCount, 1)
  assert.equal(state.pageActive, true)
  assert.equal(state.inert, false)
  assert.equal(evaluateDomExpression(activeRouteExpression(options), { pages: [retiring, current] }), true)
  assert.equal(evaluateDomExpression(activeRouteExpression(options), { pages: [retiring] }), false)
  assert.equal(evaluateDomExpression(activeRouteExpression(options), {
    hash: '#/metrics', route: 'computers', pages: [current],
  }), false)
})

test('active descendant readiness is scoped to the active route and waits for semantic transition', () => {
  const staleSwitch = domNode()
  const stalePanel = domNode({ descendants: { '.switch': [staleSwitch] } })
  const retiring = domNode({ inert: true, descendants: { '.panel': [stalePanel] } })
  const currentSwitch = domNode()
  const currentPanel = domNode({ descendants: { '.switch': [currentSwitch] } })
  const current = domNode({ descendants: { '.panel': [currentPanel] } })
  const expression = activeRouteDescendantExpression({
    hash: '#/computers',
    route: 'computers',
    pageSelector: '.computers',
    descendantSelectors: ['.panel', '.fallback-panel'],
    forbiddenVisibleSelector: '.switch',
  })

  assert.equal(evaluateDomExpression(expression, { pages: [retiring, current] }), false,
    'the active panel still carries the pre-transition switch')
  currentSwitch.hidden = true
  assert.equal(evaluateDomExpression(expression, { pages: [retiring, current] }), true,
    'the retiring panel must not prevent the active panel transition from becoming ready')
  currentPanel.hidden = true
  assert.equal(evaluateDomExpression(expression, { pages: [retiring, current] }), false,
    'a hidden panel under the active route is not ready')
  assert.equal(evaluateDomExpression(expression, { pages: [retiring] }), false,
    'a panel under only a retiring route is not ready')
})

test('both packaged drivers use the shared active Computers navigation and current tier controls', () => {
  const context = readFileSync(new URL('../context-window-drive.mjs', import.meta.url), 'utf8')
  const defects = readFileSync(new URL('../four-defects-drive.mjs', import.meta.url), 'utf8')

  for (const [name, source] of [['context-window-drive.mjs', context], ['four-defects-drive.mjs', defects]]) {
    assert.match(source, /pressForwardToActiveRoute\(window, \{[\s\S]*?hash: '#\/computers'[\s\S]*?pageSelector: '\.computers'/,
      `${name} is not waiting for the active Computers page`)
  }
  assert.match(defects, /const buttons = \[\.\.\.document\.querySelectorAll\('\[data-setup-profile-set="tier"\]'\)\][\s\S]*?buttons\[0\]\?\.closest\('\.settings-row'\)/,
    'four-defects must derive the tier row from the current tier control')
  assert.doesNotMatch(defects, /document\.querySelector\('\[data-setup-profile-row="tier"\]'\)/,
    'the stale tier wrapper selector returned')
})
