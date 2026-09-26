/* B28: HOME'S VOICE CARD CALLS A NEW AGENT TAB BY ITS NAME.
 *
 * Found by hand on candidate 2 (c2f2): with a New agent tab running, Home's
 * Voice card and its "Talk to" list read
 *
 *   standalone-12345678-90ab-4cde-8f01-23456789abcd
 *
 * instead of "Agent 2". refreshTargets labels a running session through the
 * tree's saved session roles, and a New agent tab is deliberately not on the
 * tree, so the lookup missed and the label fell through to the seat id.
 *
 * The tab's name is written down the moment the tab opens, in the open-tab
 * list (src/standalone-tab-ledger.js, mc.fleet.standalone-tabs.v1:<computer>).
 * The card now reads it. A session nothing names gets a plain word, never an
 * id: "New agent tab" for a tab's seat, "Agent" for anything else.
 *
 * These cases read the list by value and mount the real voiceCoordinator on
 * the DOM stand-in (with a small <select>/Option shim the stand-in lacks).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

import { installDomStandIn } from './lib/dom-stand-in.mjs'
import {
  createStandaloneTabLedger, readStandaloneTabNames, standaloneTabNameFor, unnamedAgentLabel,
  STANDALONE_TABS_PREFIX, UNNAMED_TAB_LABEL, UNNAMED_AGENT_LABEL,
} from '../../src/standalone-tab-ledger.js'

register('./helpers/css-stub-loader.mjs', import.meta.url)
const { voiceCoordinator } = await import('../../src/voice-coordinator.js')

const SEAT = 'standalone-12345678-90ab-4cde-8f01-23456789abcd'
const OTHER_SEAT = 'standalone-11111111-2222-4333-8444-555555555555'
const RAW_ID = /standalone-|node-7f3a/

function memoryStorage() {
  const stored = new Map()
  return {
    stored,
    get length() { return stored.size },
    key: index => [...stored.keys()][index] ?? null,
    getItem: key => (stored.has(key) ? stored.get(key) : null),
    setItem: (key, value) => { stored.set(key, String(value)) },
    removeItem: key => { stored.delete(key) },
  }
}

function tabListWith(storage, computerId, tabs) {
  const ledger = createStandaloneTabLedger({ storage, computerId })
  for (const tab of tabs) assert.equal(ledger.remember(tab), true, 'fixture tab written')
  return ledger
}

test('the open-tab list answers a running tab\'s name by its seat, and by its last session', () => {
  const storage = memoryStorage()
  tabListWith(storage, 'computer-a', [{ id: SEAT, name: 'Agent 2', tier: 'luna', effort: null, openedAt: 1, sessionId: 'session-2' }])
  tabListWith(storage, 'computer-b', [{ id: OTHER_SEAT, name: 'Agent 1', tier: null, effort: null, openedAt: 2, sessionId: null }])
  const names = readStandaloneTabNames(storage)
  assert.equal(standaloneTabNameFor({ sessionId: 'unrelated', agentId: SEAT }, names), 'Agent 2', 'by seat id')
  assert.equal(standaloneTabNameFor({ sessionId: 'session-2', agentId: 'something-else' }, names), 'Agent 2', 'by its last confirmed session')
  assert.equal(standaloneTabNameFor({ sessionId: 'x', agentId: OTHER_SEAT }, names), 'Agent 1', 'another computer\'s list is read too')
  assert.equal(standaloneTabNameFor({ sessionId: 'x', agentId: 'standalone-not-open' }, names), '', 'a seat no list holds has no name')
  assert.equal(standaloneTabNameFor({ sessionId: 'x', agentId: SEAT }, null), '', 'no list read, no name')
})

test('a damaged list costs only its own names, and storage that throws answers no names', () => {
  const storage = memoryStorage()
  tabListWith(storage, 'computer-a', [{ id: SEAT, name: 'Agent 2', openedAt: 1 }])
  storage.setItem(STANDALONE_TABS_PREFIX + 'computer-b', '{not json')
  const names = readStandaloneTabNames(storage)
  assert.equal(standaloneTabNameFor({ agentId: SEAT }, names), 'Agent 2')
  const throwing = { get length() { throw new Error('storage refused') }, key() { throw new Error('x') }, getItem() { throw new Error('x') } }
  assert.equal(standaloneTabNameFor({ agentId: SEAT }, readStandaloneTabNames(throwing)), '')
  assert.equal(standaloneTabNameFor({ agentId: SEAT }, readStandaloneTabNames(null)), '')
})

test('a running agent nothing names gets a plain word, never its id', () => {
  assert.equal(UNNAMED_TAB_LABEL, 'New agent tab')
  assert.equal(UNNAMED_AGENT_LABEL, 'Agent')
  assert.equal(unnamedAgentLabel(SEAT), UNNAMED_TAB_LABEL)
  assert.equal(unnamedAgentLabel('standalone-never-declared'), UNNAMED_TAB_LABEL)
  assert.equal(unnamedAgentLabel('node-7f3a9c'), UNNAMED_AGENT_LABEL)
  assert.equal(unnamedAgentLabel(undefined), UNNAMED_AGENT_LABEL)
})

/* THE CARD ITSELF. The real voiceCoordinator, mounted on the DOM stand-in with
   the desktop bridges it reads: window.mcVoice.targets() answers the running
   sessions exactly as shell/voice-host.cjs shapes them. */
async function mountedCard(t, { targets, tabs = [] }) {
  const dom = installDomStandIn(globalThis)
  const storage = memoryStorage()
  if (tabs.length) tabListWith(storage, 'this-computer', tabs)
  const previousOption = Object.getOwnPropertyDescriptor(globalThis, 'Option')
  globalThis.Option = function Option(text = '', value = '') {
    const option = globalThis.document.createElement('option')
    option.textContent = String(text)
    option.value = String(value)
    return option
  }
  globalThis.window.localStorage = storage
  globalThis.window.mcVoice = { targets: async () => targets, stop: async () => ({ ok: true }) }
  globalThis.window.mcAgent = {}
  let card = null
  t.after(() => {
    try { card?.destroy() } finally {
      if (previousOption) Object.defineProperty(globalThis, 'Option', previousOption)
      else delete globalThis.Option
      dom.restore()
    }
  })
  card = voiceCoordinator({})
  /* The stand-in has no <select> behaviour; these three are the whole of what
     refreshTargets and the compact label use. */
  const select = card.el.querySelector('[data-voice-target]')
  select.value = ''
  select.add = option => select.append(option)
  Object.defineProperty(select, 'selectedOptions', { get: () => select.children.filter(option => option.value === select.value).slice(0, 1) })
  for (let turn = 0; turn < 12; turn += 1) await new Promise(resolve => setTimeout(resolve, 0))
  const options = select.children.filter(option => option.value).map(option => option.textContent)
  return { card, select, options, contact: card.el.querySelector('[data-voice-contact-name]').textContent }
}

test('Home\'s voice card names a running New agent tab by the tab\'s name', async t => {
  const f = await mountedCard(t, {
    targets: [{ sessionId: 'session-2', agentId: SEAT, tier: 'luna', state: 'open' }],
    tabs: [{ id: SEAT, name: 'Agent 2', tier: 'luna', effort: null, openedAt: 1, sessionId: 'session-2' }],
  })
  assert.deepEqual(f.options, ['Agent 2'], 'THE DEFECT: the "Talk to" list names the tab by its seat id')
  assert.equal(f.contact, 'Agent 2', 'the card\'s own label names the tab')
  assert.doesNotMatch(f.card.el.textContent, RAW_ID)
})

test('a running session nothing names reads as a plain word on the card, never as its id', async t => {
  const f = await mountedCard(t, {
    targets: [
      { sessionId: 'session-9', agentId: OTHER_SEAT, tier: 'luna', state: 'open' },
      { sessionId: 'session-8', agentId: 'node-7f3a9c', tier: 'luna', state: 'open' },
    ],
  })
  assert.deepEqual([...f.options].sort(), ['Agent', 'New agent tab'])
  assert.doesNotMatch(f.options.join(' '), RAW_ID)
  assert.doesNotMatch(f.contact, RAW_ID)
  assert.doesNotMatch(f.options.join(' '), /luna/, 'nor the model row id in its place')
})
