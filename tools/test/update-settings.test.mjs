/* THE SETTINGS ROW FOR THE UPDATE CHECK, HELD STILL.
 *
 * src/update-settings.js draws the three-way control that remembers how
 * updates are checked, and it is the only way back from `never`. This suite
 * holds the three states, the sentence beside the control (the truth first,
 * never contradicting the lit button), the class the control must and must
 * not carry, and the window-with-no-store case that draws a sentence and no
 * control.
 *
 * Run: node --test tools/test/update-settings.test.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  DEFAULT_UPDATE_POLICY,
  UPDATE_CONTROL_LABEL,
  UPDATE_NO_STORE_SENTENCE,
  UPDATE_POLICY_READ_FAILED_CODE,
  UPDATE_POLICY_READ_FAILED_SENTENCE,
  UPDATE_POLICIES,
  UPDATE_POLICY_KEY,
  UPDATE_SAVE_FAILED,
  UPDATE_SECTION,
  UPDATE_SETTING_COUNT,
  UPDATE_SETTING_ID,
  createUpdateSettings,
  defaultReadUpdatePolicy,
  defaultWriteUpdatePolicy,
  readUpdatePolicyValue,
  updateStateSentence,
} from '../../src/update-settings.js'
import { groupOfSection } from '../../src/settings-presentation.js'
import updateCheck from '../../shell/update-check.cjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = relative => readFileSync(path.join(ROOT, ...relative.split('/')), 'utf8')

/* Read the rendered elements as a browser would: attribute order and quoting
   are serialization choices, while attribute values and class tokens are the
   interface the page actually exposes. */
function elementsFromMarkup(html, tagName) {
  return [...html.matchAll(new RegExp(`<${tagName}\\b([^>]*)>`, 'gi'))].map(([, source]) => {
    const attributes = new Map()
    for (const match of source.matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
      attributes.set(match[1], match[2] ?? match[3] ?? match[4] ?? '')
    }
    return {
      getAttribute: name => attributes.get(name) ?? null,
      hasAttribute: name => attributes.has(name),
      classList: new Set((attributes.get('class') || '').split(/\s+/).filter(Boolean)),
    }
  })
}

const updateButtonsFrom = html => elementsFromMarkup(html, 'button')
  .filter(button => button.hasAttribute('data-update-policy'))

test('Linux and macOS explain the supported update path without an ineffective policy control', () => {
  for (const platform of ['linux', 'darwin']) {
    const settings = createUpdateSettings({ platform, readPolicy: () => 'always' })
    const html = settings.markup()
    assert.match(html, /Use the installer or launcher/)
    assert.doesNotMatch(html, /Checks on its own|Ask me means/)
    assert.equal(updateButtonsFrom(html).length, 0)
  }
  assert.equal(updateButtonsFrom(createUpdateSettings({ platform: 'win32', readPolicy: () => 'ask' }).markup()).length, 3)
})

/* The shape of the default reader and writer: absence reads as the default
   (never as null, which means "no store"), and the default is stored as
   absence. `raw` is what the file would hold. */
function memoryStore(initial = {}) {
  const map = new Map(Object.entries(initial))
  let value = map.has(UPDATE_POLICY_KEY) ? map.get(UPDATE_POLICY_KEY) : null
  return {
    read: () => readUpdatePolicyValue(value),
    raw: () => value,
    write: (policy) => { value = policy === DEFAULT_UPDATE_POLICY ? null : policy },
  }
}

/* ---------- the key and the words agree with the installed application ---------- */

test('the row and the launch check share one key, one default and one vocabulary', () => {
  assert.equal(UPDATE_POLICY_KEY, updateCheck.POLICY_KEY)
  assert.equal(DEFAULT_UPDATE_POLICY, updateCheck.DEFAULT_POLICY)
  assert.deepEqual(UPDATE_POLICIES.map(policy => policy.value), [...updateCheck.POLICIES])
  for (const odd of [undefined, null, '', 'sometimes', 'ALWAYS', 42]) {
    assert.equal(readUpdatePolicyValue(odd), updateCheck.readPolicyValue(odd), `both read ${String(odd)} the same way`)
  }
})

test('the section is drawn under System, which is in a group the page renders', () => {
  assert.equal(UPDATE_SECTION, 'System')
  assert.ok(groupOfSection(UPDATE_SECTION), 'System is grouped, so the row is on the page')
  assert.equal(UPDATE_SETTING_COUNT, 1)
})

/* ---------- three states, three sentences, never a contradiction ---------- */

test('the three labels are the owner\'s three answers', () => {
  assert.deepEqual(UPDATE_POLICIES.map(policy => policy.label), ['Ask me', 'Always check', 'Never check'])
})

test('each state sentence says its own truth first and names no other state as current', () => {
  const ask = updateStateSentence('ask')
  const always = updateStateSentence('always')
  const never = updateStateSentence('never')
  assert.match(ask, /^Asks at launch/)
  assert.match(always, /^Checks on its own at launch/)
  assert.match(always, /once a day/)
  assert.match(always, /asks before installing/)
  assert.match(never, /^Never checks\./)
  assert.match(never, /toolsenabled\.ai\/download/, 'never says where updates are instead')
  assert.ok(!/never/i.test(ask) && !/never/i.test(always), 'a checking state does not read as never')
  assert.ok(!/on its own/.test(ask) && !/on its own/.test(never), 'only always says on its own')
  assert.equal(updateStateSentence('sometimes'), ask, 'an odd value reads as the default')
})

for (const policy of UPDATE_POLICIES) {
  test(`state ${policy.value}: the lit button and the sentence agree`, () => {
    const store = memoryStore({ [UPDATE_POLICY_KEY]: policy.value })
    const controller = createUpdateSettings({ readPolicy: store.read, writePolicy: store.write })
    const html = controller.markup()
    const lit = updateButtonsFrom(html)
      .filter(button => button.getAttribute('aria-pressed') === 'true')
      .map(button => button.getAttribute('data-update-policy'))
    assert.deepEqual(lit, [policy.value], 'exactly one button is lit and it is the stored one')
    assert.ok(html.includes(updateStateSentence(policy.value)), 'the sentence is the one for the lit state')
    assert.ok(elementsFromMarkup(html, 'article').some(element => element.getAttribute('data-setting-id') === UPDATE_SETTING_ID), 'the row exposes its setting id')
    assert.ok(html.includes(UPDATE_CONTROL_LABEL))
  })
}

/* ---------- the control's class, and why ---------- */

test('the control is a .seg and NOT a .settings-seg, and its buttons carry no catalogue attribute', () => {
  const store = memoryStore()
  const html = createUpdateSettings({ readPolicy: store.read, writePolicy: store.write }).markup()
  const segments = elementsFromMarkup(html, 'div').filter(element => element.classList.has('seg'))
  assert.equal(segments.length, 1, 'one segmented control is rendered')
  assert.ok(!segments[0].classList.has('settings-seg'), 'the page\'s own handler must never see this group')
  const buttons = updateButtonsFrom(html)
  assert.ok(buttons.every(button => !button.hasAttribute('data-setting-value')), 'the catalogue click handler keys on data-setting-value')
  assert.equal(buttons.length, UPDATE_POLICIES.length, 'every update policy has a button')
})

/* ---------- no store: the sentence, no control ---------- */

test('a window with no durable store draws the sentence and no control', () => {
  const controller = createUpdateSettings({ readPolicy: () => null, writePolicy: () => { throw new Error('no store') } })
  const html = controller.markup()
  assert.ok(html.includes(UPDATE_NO_STORE_SENTENCE))
  assert.equal(updateButtonsFrom(html).length, 0, 'no button whose press could not be saved')
  assert.equal(elementsFromMarkup(html, 'div').filter(element => element.classList.has('seg')).length, 0, 'no seg at all')
  assert.equal(controller.getPolicy(), null)
})

test('the default reader answers null outside the shell and reads the durable store inside it', () => {
  const saved = { window: globalThis.window, localStorage: globalThis.localStorage }
  try {
    delete globalThis.window
    assert.equal(defaultReadUpdatePolicy(), null)
    assert.throws(() => defaultWriteUpdatePolicy('always'), /no durable store/)

    const map = new Map()
    globalThis.window = { mcPrefs: { available: true } }
    globalThis.localStorage = {
      getItem: key => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => { map.set(key, String(value)) },
      removeItem: key => { map.delete(key) },
    }
    assert.equal(defaultReadUpdatePolicy(), 'ask')
    defaultWriteUpdatePolicy('never')
    assert.equal(map.get(UPDATE_POLICY_KEY), 'never')
    assert.equal(defaultReadUpdatePolicy(), 'never')
    defaultWriteUpdatePolicy('ask')
    assert.equal(map.has(UPDATE_POLICY_KEY), false, 'the default is stored as absence')
  } finally {
    if (saved.window === undefined) delete globalThis.window
    else globalThis.window = saved.window
    if (saved.localStorage === undefined) delete globalThis.localStorage
    else globalThis.localStorage = saved.localStorage
  }
})

test('the default reader separates a failed live read from absence without defeating the launch-copy fallback', () => {
  const saved = { window: globalThis.window, localStorage: globalThis.localStorage }
  try {
    const map = new Map([[UPDATE_POLICY_KEY, 'ask']])
    globalThis.localStorage = {
      getItem: key => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => { map.set(key, String(value)) },
      removeItem: key => { map.delete(key) },
    }
    /* The launch copy says ask; the file, written by the launch dialog after
       the page booted, says never. The row must show never. */
    const asked = []
    globalThis.window = { mcPrefs: { available: true, read: key => { asked.push(key); return { ok: true, value: 'never' } } } }
    assert.equal(defaultReadUpdatePolicy(), 'never')
    assert.deepEqual(asked, [UPDATE_POLICY_KEY])

    /* A build with no live reader legitimately uses the launch copy. Keep
       this control: never reading that copy would make the failure assertions
       pass while reinstating the stale-settings cost the fallback avoids. */
    let cachedReads = 0
    globalThis.localStorage.getItem = key => { cachedReads += 1; return map.has(key) ? map.get(key) : null }
    globalThis.window = { mcPrefs: { available: true } }
    assert.equal(defaultReadUpdatePolicy(), 'ask')
    assert.equal(cachedReads, 1, 'a missing live-read capability still uses the cached launch copy')

    /* Refusal, resource pressure, and even an unstructured throw all mean
       "could not tell", never that the key is absent and never the cached
       answer. Every call retries rather than latching the failure. */
    globalThis.window = { mcPrefs: { available: true, read: () => ({ ok: false, error: { code: 'MC_PREFS_SENDER_REFUSED' } }) } }
    assert.throws(defaultReadUpdatePolicy, error => error.code === UPDATE_POLICY_READ_FAILED_CODE)
    assert.equal(cachedReads, 1, 'a refused live read does not consult the cached launch copy')

    let attempts = 0
    const busy = Object.assign(new Error('busy'), { code: 'EBUSY' })
    globalThis.window = { mcPrefs: { available: true, read: () => { attempts += 1; throw attempts === 1 ? busy : 'opaque failure' } } }
    const controller = createUpdateSettings()
    assert.equal(controller.getPolicy().code, UPDATE_POLICY_READ_FAILED_CODE)
    const html = controller.markup()
    assert.ok(html.includes(UPDATE_POLICY_READ_FAILED_SENTENCE))
    assert.ok(!html.includes(UPDATE_NO_STORE_SENTENCE), 'failure is not presented as an absent store')
    assert.equal(updateButtonsFrom(html).length, 0)
    assert.equal(attempts, 2, 'the failed answer is not cached or latched')
    assert.equal(cachedReads, 1, 'neither failed attempt uses the cached launch copy')

    /* An absent key on the live read is the default, never "no store". */
    globalThis.window = { mcPrefs: { available: true, read: () => ({ ok: true, value: null }) } }
    assert.equal(defaultReadUpdatePolicy(), 'ask')
  } finally {
    if (saved.window === undefined) delete globalThis.window
    else globalThis.window = saved.window
    if (saved.localStorage === undefined) delete globalThis.localStorage
    else globalThis.localStorage = saved.localStorage
  }
})

test('the live read exists in the preload and is fenced in main.cjs exactly like the write', () => {
  const preload = read('shell/fleet-profile-preload.cjs')
  assert.ok(preload.includes("read: key => ipcRenderer.sendSync('mc-prefs:read', { key })"), 'mcPrefs.read is exposed')
  const main = read('shell/main.cjs')
  const handler = main.slice(main.indexOf("ipcMain.on('mc-prefs:read'"))
  assert.ok(handler.length > 0, 'main.cjs answers mc-prefs:read')
  const body = handler.slice(0, handler.indexOf('\n})'))
  assert.ok(body.includes("if (!trustedFleetProfileSender(event)) { event.returnValue = prefsRefusal('read'); return }"), 'the sender fence')
  assert.ok(body.includes("if (localDataErased) { event.returnValue = prefsErasedRefusal('read'); return }"), 'the erased fence')
  assert.ok(body.includes('rendererPrefs.snapshot().values[key]'), 'reads the file, not a copy')
})

/* ---------- a press moves the store, the screen follows the store ---------- */

test('setPolicy writes the store and the next paint lights the stored value', () => {
  const store = memoryStore()
  const controller = createUpdateSettings({ readPolicy: store.read, writePolicy: store.write })
  controller.setPolicy('never')
  assert.equal(store.read(), 'never')
  assert.equal(updateButtonsFrom(controller.markup()).find(button => button.getAttribute('data-update-policy') === 'never')?.getAttribute('aria-pressed'), 'true')
  controller.setPolicy('ask')
  assert.equal(store.raw(), null, 'the default is stored as absence')
  assert.equal(updateButtonsFrom(controller.markup()).find(button => button.getAttribute('data-update-policy') === 'ask')?.getAttribute('aria-pressed'), 'true')
  controller.setPolicy('not a policy')
  assert.equal(store.raw(), null, 'an unknown press is the default, never a stray string in the file')
})

test('a write that fails leaves the store alone and says so beside the control', () => {
  const store = memoryStore({ [UPDATE_POLICY_KEY]: 'always' })
  const controller = createUpdateSettings({
    readPolicy: store.read,
    writePolicy: () => { throw new Error('EACCES') },
  })
  controller.setPolicy('never')
  const html = controller.markup()
  assert.equal(store.read(), 'always')
  assert.equal(updateButtonsFrom(html).find(button => button.getAttribute('data-update-policy') === 'always')?.getAttribute('aria-pressed'), 'true', 'the control springs back to the store')
  assert.ok(html.includes(UPDATE_SAVE_FAILED))
  assert.ok(elementsFromMarkup(html, 'p').some(element => element.getAttribute('role') === 'alert'), 'the failure notice is announced as an alert')
})

test('search finds it by the words a person would type', () => {
  const store = memoryStore()
  const controller = createUpdateSettings({ readPolicy: store.read, writePolicy: store.write })
  for (const query of ['update', 'updates', 'check for updates', 'new version', 'never check', 'automatically']) {
    assert.equal(controller.matches(query), true, query)
  }
  assert.equal(controller.matches('sankey gradient'), false)
  assert.equal(controller.matches(''), true)
})

/* ---------- the page really mounts it ---------- */

test('src/views/settings.js mounts the controller the way it mounts the connect section', () => {
  const source = read('src/views/settings.js')
  assert.ok(source.includes("from '../update-settings.js'"))
  assert.ok(source.includes('const updateController = createUpdateSettings({ stageWrite, draft })'))
  assert.match(source, /if \(section === 'System'\) return [^\n]*profileController\.markup\(\) \+ updateController\.markup\(\)/, 'drawn under System, including when wrapped in the settings mode panel')
  assert.ok(source.includes('updateController.bind(root)'), 'bound, so the buttons do something')
  assert.ok(source.includes('updateController.afterRender(root)'))
  assert.ok(source.includes('updateController.destroy()'))
  assert.ok(source.includes('updateController.matches(normalized)'), 'searchable')
})
