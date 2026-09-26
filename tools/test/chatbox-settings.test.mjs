/* The settings-page controller, at the boundary used by src/views/settings.js.
 * This file deliberately uses the same small root/event stand-in as the other
 * renderer unit tests: the controller needs delegation and outerHTML, not a
 * browser or a byte-for-byte HTML snapshot. */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CHATBOX_SECTION,
  CHATBOX_SETTING_COUNT,
  createChatboxSettings,
} from '../../src/chatbox-settings.js'

function storage(initial = {}) {
  const values = new Map(Object.entries(initial))
  globalThis.localStorage = {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  }
  return values
}

function rootStandIn(initialMarkup) {
  const listeners = new Map()
  let rendered = initialMarkup
  const section = {
    querySelector: selector => selector === '.settings-prefix' && rendered.includes('settings-prefix') ? {} : null,
    set outerHTML(value) { rendered = value },
  }
  return {
    root: {
      addEventListener: (type, listener) => listeners.set(type, listener),
      removeEventListener: (type, listener) => {
        if (listeners.get(type) === listener) listeners.delete(type)
      },
      querySelector: selector => selector === '[data-chatbox-settings]' ? section : null,
      contains: () => true,
    },
    dispatch(type, target) { listeners.get(type)?.({ target }) },
    markup: () => rendered,
    listenerCount: () => listeners.size,
  }
}

const delegatedTarget = (selector, dataset) => ({
  dataset,
  closest: query => query === selector ? { dataset } : null,
})

const settle = async () => {
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
}

test('the exported section contract and initial render expose both paid-for choices', () => {
  storage()
  const settings = createChatboxSettings()
  const markup = settings.markup({ searchResult: true })

  const renderedSettingCount = [...markup.matchAll(/data-chatbox-row="(?:agents|runs)"/g)].length
  assert.equal(renderedSettingCount, CHATBOX_SETTING_COUNT, 'the exported count must agree with the rendered chatbox settings')
  assert.equal(CHATBOX_SETTING_COUNT, 2, 'the settings footer must count both chatbox choices')
  assert.equal(CHATBOX_SECTION, 'Home screen', 'the controller must remain in the home-screen section')
  assert.match(markup, /data-chatbox-set="agents"/, 'the render must offer the agent-selection control')
  assert.match(markup, /data-chatbox-set="runs"/, 'the render must offer the run-visibility control')
  assert.match(markup, /Looking[^<]*agents/i, 'an unread agent list must be described as pending, not empty')
  assert.match(markup, /settings-prefix/, 'a search result must retain its orienting prefix')
})

test('real delegated clicks persist each choice and repaint without losing search context', () => {
  const values = storage()
  const settings = createChatboxSettings()
  const view = rootStandIn(settings.markup({ searchResult: true }))
  settings.bind(view.root)

  view.dispatch('click', delegatedTarget('[data-chatbox-set]', {
    chatboxSet: 'runs',
    chatboxValue: 'hidden',
  }))
  assert.equal(values.get('mc.chat.runs'), 'hidden', 'choosing to hide runs must persist that run mode')
  assert.match(view.markup(), /data-chatbox-value="hidden" aria-pressed="true"/, 'the chosen run mode must repaint as selected')
  assert.match(view.markup(), /settings-prefix/, 'repainting a search result must keep its orienting prefix')

  view.dispatch('click', delegatedTarget('[data-chatbox-set]', {
    chatboxSet: 'agents',
    chatboxValue: 'chosen',
  }))
  assert.deepEqual(JSON.parse(values.get('mc.chat.agents')), [], 'narrowing before discovery must persist the explicit picked-list mode')
  assert.match(view.markup(), /data-chatbox-value="chosen" aria-pressed="true"/, 'the picked-agent mode must repaint as selected')

  settings.destroy()
  assert.equal(view.listenerCount(), 0, 'destroy must remove both delegated listeners')
})

test('search matches the language real callers pass, independent of case and padding', () => {
  storage()
  const settings = createChatboxSettings()

  assert.equal(settings.matches('  AGENT RUNS  '), true, 'search must find the run setting case-insensitively')
  assert.equal(settings.matches('which agents'), true, 'search must find the agent setting')
  assert.equal(settings.matches(''), true, 'an empty search must include the section')
  assert.equal(settings.matches('printer ink levels'), false, 'an unrelated search must not claim this section')
})

test('a known example source discovers its cast even when live reads fail', async t => {
  storage({ 'mc.example': 'on' })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('offline by design') }
  t.after(() => { globalThis.fetch = originalFetch })

  const settings = createChatboxSettings()
  const view = rootStandIn(settings.markup())
  settings.afterRender(view.root)
  await settle()

  assert.doesNotMatch(view.markup(), /Looking[^<]*agents/i, 'a completed known-example lookup must leave the pending state')
  assert.match(view.markup(), /data-chatbox-agent=/, 'the known example source must offer its agents despite failed live reads')
  assert.doesNotMatch(view.markup(), /Nothing to choose from yet/, 'failed live reads must not erase the known example cast')
})
