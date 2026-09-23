/* Exported behaviour of the Settings section "This computer".
 *
 * Run: node --test tools/test/this-computer-settings.test.mjs
 *
 * WHERE THESE TESTS COME FROM. They were tools/test/guide.test.mjs, which
 * covered the page src/views/guide.js -- "What this copy needs". That page is
 * gone and its working half is src/this-computer-settings.js, mounted as a row
 * of Settings. Every assertion below is the assertion that pinned the page,
 * re-aimed at the module: nothing was dropped and nothing was loosened, because
 * the behaviour did not change -- only where it is drawn.
 *
 * The stand-ins below model only the DOM that this renderer reads and writes.
 * In particular, controls are exposed as named fields rather than treating the
 * generated markup as a byte-for-byte API.
 *
 * THE MODULE BUILDS TWO ELEMENTS, NOT ONE, and that is the one shape change the
 * move forced. The page was a single tree with the feedback section inside it.
 * A Settings section is a list of rows, and the composer belongs to its own row
 * -- revealed by a press, several rows below the programs -- so the module
 * hands back `el` and `feedbackEl` separately. mount() therefore serves two
 * distinct roots from document.createElement, in the order the module asks for
 * them, instead of one root standing in for both.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.css')) return { url: new URL(specifier, context.parentURL).href, shortCircuit: true }
    return nextResolve(specifier, context)
  }
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)

const {
  THIS_COMPUTER_HREF,
  THIS_COMPUTER_PROGRAMS_ROW,
  THIS_COMPUTER_SECTION,
  createThisComputerSettings,
  applyInstallSnapshot,
  copyLineFor,
} = await import('../../src/this-computer-settings.js')
const { FEEDBACK_COPY } = await import('../../src/feedback-compose.js')
const { FIRST_RUN_NEEDS, WORKS_HERE } = await import('../../src/first-run-needs.js')
const { FIRST_VISIT_SECTION, SETTINGS_GROUPS } = await import('../../src/settings-presentation.js')

const PROVIDERS = ['codex', 'claude', 'gemini']

function attribute(markup, name) {
  const match = markup.match(new RegExp(`(?:^|\\s)${name}(?:="([^"]*)")?(?=\\s|>)`))
  return match ? (match[1] ?? true) : undefined
}

function controlFrom(markup, marker) {
  const tag = markup.match(new RegExp(`<button[^>]*${marker}[^>]*>`))?.[0]
  if (!tag) return null
  return {
    disabled: attribute(tag, 'disabled') === true,
    title: attribute(tag, 'title'),
    hidden: attribute(tag, 'hidden') === true,
    listeners: {},
    addEventListener(kind, listener) { this.listeners[kind] = listener },
  }
}

function signInPanel(id) {
  const fields = {}
  return {
    dataset: { signinProvider: id, signinProgram: `${id[0].toUpperCase()}${id.slice(1)}` },
    hidden: true,
    get innerHTML() { return this.markup || '' },
    set innerHTML(value) {
      this.markup = value
      fields.start = controlFrom(value, 'data-signin-start')
      fields.install = controlFrom(value, 'data-signin-install')
      fields.stop = controlFrom(value, 'data-signin-stop')
      fields.status = {
        textContent: value.match(/<output[^>]*data-signin-status[^>]*>([^<]*)<\/output>/)?.[1] || '',
      }
      fields.log = { textContent: '', hidden: true }
      fields.copy = /data-signin-copy/.test(value) ? { textContent: '', hidden: true } : null
    },
    querySelector(selector) {
      return ({
        '[data-signin-start]': fields.start,
        '[data-signin-install]': fields.install,
        '[data-signin-stop]': fields.stop,
        '[data-signin-status]': fields.status,
        '[data-signin-log]': fields.log,
        '[data-signin-copy]': fields.copy,
      })[selector] || null
    },
    fields,
  }
}

/* THE FEEDBACK SECTION'S FOUR CONTROLS -- [data-feedback-text],
 * [data-feedback-build], [data-feedback-send], [data-feedback-status] --
 * modelled the same way signInPanel() models a sign-in panel: named fields
 * a test reads and writes, an addEventListener that RECORDS the listener
 * the module actually attaches rather than one this file invents. Driving a
 * control means calling `send.listeners.click()`, which runs the exact
 * function fillFeedback() registered -- the real markup path, not a direct
 * call to submitFeedback() or composeFeedback() from the test. */
function feedbackNode(controls) {
  return {
    dataset: {}, hidden: true,
    /* The composer's own root, which is what the module builds second. Its four
       controls are found ON IT rather than on the programs root, because in
       Settings they are in a different row entirely. */
    querySelector(selector) {
      return ({
        '[data-feedback-send]': controls.send,
        '[data-feedback-status]': controls.status,
        '[data-feedback-text]': controls.text,
        '[data-feedback-build]': controls.build,
      })[selector] || null
    },
    querySelectorAll: () => [],
  }
}
function feedbackControlNode(extra = {}) {
  return { listeners: {}, addEventListener(kind, listener) { this.listeners[kind] = listener }, ...extra }
}

function mount(bridge, { fetchImpl } = {}) {
  const presence = Object.fromEntries(PROVIDERS.map(id => [id, {
    dataset: { presence: 'pending' }, textContent: '', hidden: true,
  }]))
  const signIns = Object.fromEntries(PROVIDERS.map(id => [id, signInPanel(id)]))
  const tags = Object.fromEntries(PROVIDERS.map(id => [id, { textContent: '' }]))
  const accounts = PROVIDERS.slice(0, 2).map(id => ({
    dataset: { accountsProvider: id, accountsProgram: id }, hidden: true, innerHTML: '',
  }))
  const feedback = {
    send: feedbackControlNode({ disabled: false }),
    status: feedbackControlNode({ textContent: '', hidden: true }),
    text: feedbackControlNode({ value: '' }),
    build: feedbackControlNode({ checked: false }),
  }
  feedback.section = feedbackNode(feedback)
  const root = {
    isConnected: true,
    dataset: {},
    querySelector(selector) {
      let match = selector.match(/data-reach-tag="([^"]+)"/)
      if (match) return tags[match[1]] || null
      match = selector.match(/data-provider="([^"]+)"/)
      if (match) return presence[match[1]] || null
      match = selector.match(/data-signin-provider="([^"]+)"/)
      if (match) return signIns[match[1]] || null
      return null
    },
    querySelectorAll(selector) {
      return selector === '.guide-accounts-panel' ? accounts : []
    },
  }
  const priorDocument = globalThis.document
  const priorWindow = globalThis.window
  const priorFetch = globalThis.fetch
  /* THE MODULE ASKS FOR ITS TWO ROOTS IN A FIXED ORDER -- the programs list,
     then the composer -- so they are handed out in that order. Serving one node
     for both would let a read aimed at the composer land on the programs list
     and still look like it worked, which is exactly the confusion the split
     into two elements exists to prevent. A third request would be a shape this
     file does not model, so it fails loudly rather than quietly reusing one. */
  const roots = [root, feedback.section]
  globalThis.document = {
    createElement() {
      const next = roots.shift()
      assert.ok(next, 'the module built more elements than this stand-in models')
      return { set innerHTML(value) { this.markup = value }, content: { firstElementChild: next } }
    },
  }
  globalThis.window = { mcProviders: bridge }
  /* No stub given means no fetch at all -- exactly src/feedback-compose.js's
     own fail-closed case, and the honest default for every test in this
     file that has nothing to do with the feedback door: it must not reach
     out, and it must not throw for want of a global that a browser or this
     application's own shell always provides one way or another. */
  if (fetchImpl) globalThis.fetch = fetchImpl
  else delete globalThis.fetch
  const view = createThisComputerSettings()
  return {
    view, presence, signIns, feedback, tags,
    async settled() {
      await new Promise(resolve => setImmediate(resolve))
      await new Promise(resolve => setImmediate(resolve))
    },
    restore() {
      view.destroy()
      if (priorDocument === undefined) delete globalThis.document
      else globalThis.document = priorDocument
      if (priorWindow === undefined) delete globalThis.window
      else globalThis.window = priorWindow
      if (priorFetch === undefined) delete globalThis.fetch
      else globalThis.fetch = priorFetch
    },
  }
}

/** A GET/POST-aware fetch stub for /v1/feedback, matching feedback-compose.test.mjs's own. */
function feedbackFetchStub({
  probe = { available: true }, throwOnProbe = false,
  submit = { received: true }, submitStatus = 202, throwOnSubmit = false,
} = {}) {
  const posts = []
  return Object.assign(async (url, options = {}) => {
    if (options.method === 'POST') {
      posts.push(JSON.parse(options.body))
      if (throwOnSubmit) throw new Error('network unreachable')
      return { ok: submitStatus >= 200 && submitStatus < 300, status: submitStatus, json: async () => submit }
    }
    if (throwOnProbe) throw new Error('network unreachable')
    return { ok: true, status: 200, json: async () => probe }
  }, { posts })
}

test('the section carries successful presence answers as machine-readable state', async t => {
  const page = mount({
    presence: async () => ({ ok: true, providers: [
      { id: 'codex', installed: 'yes', signedIn: 'yes' },
      { id: 'claude', installed: 'yes', signedIn: 'no' },
    ] }),
  })
  t.after(() => page.restore())
  await page.settled()

  assert.deepEqual(page.presence.codex.dataset, {
    presence: 'ready', installed: 'yes', signedIn: 'yes',
  }, 'a ready provider lost the data fields that drivers and support read')
  assert.deepEqual(page.presence.claude.dataset, {
    presence: 'incomplete', installed: 'yes', signedIn: 'no',
  }, 'a provider needing sign-in was presented as ready or lost its underlying state')
})

test('a program the machine did not report as installed is not tagged as working here now', async () => {
  // T1439: every row of a fresh install read 'Works here now' above 'Not on this computer yet.'
  const page = mount({
    presence: async () => ({ ok: true, providers: [
      { id: 'codex', installed: 'yes', signedIn: 'yes' },
      { id: 'claude', installed: 'no', signedIn: 'no' },
    ] }),
  })
  try {
    await page.settled()
    assert.equal(page.tags.codex.textContent, 'Works here now', 'an installed program keeps its positive tag')
    assert.equal(page.tags.claude.textContent, 'Can run here once installed', 'a missing program was announced as working here now')
  } finally { page.restore() }

  const unread = mount({ presence: async () => { throw new Error('read unavailable') } })
  try {
    await unread.settled()
    for (const id of PROVIDERS) {
      assert.equal(unread.tags[id].textContent, 'Can run here once installed', `${id} claimed to work here although the machine could not tell`)
    }
  } finally { unread.restore() }
})

test('a browser copy with no program bridge points to the desktop app and never says a disabled button works', async () => {
  // T1526: 'Both buttons still work; press the one you need' under three disabled
  // buttons, 'Reopening ToolsEnabled', and 'Update ToolsEnabled on that computer'.
  const page = mount(undefined)
  try {
    await page.settled()
    for (const id of PROVIDERS) {
      assert.match(page.presence[id].textContent, /ToolsEnabled desktop app/, `${id} presence line`)
      assert.doesNotMatch(page.presence[id].textContent, /Reopening ToolsEnabled/)
      const markup = page.signIns[id].innerHTML
      assert.match(markup, /installed and signed in from the ToolsEnabled desktop app/, `${id} sign-in note`)
      assert.doesNotMatch(markup, /Both buttons still work/)
      assert.equal(page.signIns[id].fields.status.textContent, '', `${id} still tells a visitor to update an installed copy`)
      assert.equal(page.signIns[id].fields.install.disabled, true)
    }
  } finally { page.restore() }
})

test('an unreadable presence stays unknown instead of becoming definitely absent', async t => {
  const page = mount({ presence: async () => { throw new Error('read unavailable') } })
  t.after(() => page.restore())
  await page.settled()

  for (const id of PROVIDERS) {
    const slot = page.presence[id]
    assert.equal(slot.dataset.installed, 'unknown', `${id} converted a failed read into an installation verdict`)
    assert.equal(slot.dataset.signedIn, 'unknown', `${id} converted a failed read into a sign-in verdict`)
    assert.match(slot.textContent, /could not tell/i, `${id} did not tell the person that its presence read failed`)
  }
})

test('sign-in controls are enabled only for available verbs and disabled controls carry reasons', async t => {
  const page = mount({
    presence: async () => ({ ok: true, providers: [{ id: 'codex', installed: 'no', signedIn: 'no' }] }),
    installStart: async () => ({ ok: true }),
  })
  t.after(() => page.restore())
  await page.settled()

  const { install, start, stop, status } = page.signIns.codex.fields
  assert.equal(install.disabled, false, 'Install stayed disabled although its bridge verb is callable')
  assert.equal(start.disabled, true, 'Sign in was enabled without a callable bridge verb')
  assert.match(start.title, /unavailable/i, 'the disabled Sign in control carries no refusal reason')
  assert.equal(stop.disabled, true, 'Stop was enabled without a callable bridge verb')
  assert.match(stop.title, /unavailable/i, 'the disabled Stop control carries no refusal reason')
  assert.match(status.textContent, /unavailable/i, 'control refusals were hidden in attributes instead of also reaching the reader')
})

// ---------------------------------------------------------------------------
// THE "?" DOOR: [data-feedback-text], [data-feedback-build],
// [data-feedback-send], [data-feedback-status], driven by firing the exact
// listener the module attached to the real button -- never by calling
// submitFeedback()/composeFeedback() directly from a test.
// ---------------------------------------------------------------------------

test('the door renders and wires its controls only when the backend answers available', async t => {
  const page = mount({}, { fetchImpl: feedbackFetchStub({ probe: { available: true } }) })
  t.after(() => page.restore())
  await page.settled()

  assert.equal(page.feedback.section.hidden, false, 'available:true must reveal the section')
  assert.equal(page.feedback.section.dataset.feedbackAvailable, 'yes')
  assert.equal(typeof page.feedback.send.listeners.click, 'function', 'the send control must be wired once the door is open')
})

test('the door stays absent -- hidden, and with NO controls wired -- when the backend says unavailable', async t => {
  const page = mount({}, { fetchImpl: feedbackFetchStub({ probe: { available: false } }) })
  t.after(() => page.restore())
  await page.settled()

  assert.equal(page.feedback.section.hidden, true, 'unavailable must never be shown as a disabled control -- the door is absent')
  assert.equal(page.feedback.section.dataset.feedbackAvailable, 'no')
  assert.equal(page.feedback.send.listeners.click, undefined, 'no listener may be attached to a door that never opened -- never a dead button')
})

test('the door stays absent when the backend cannot be reached at all, same as an explicit no', async t => {
  const page = mount({}, { fetchImpl: feedbackFetchStub({ throwOnProbe: true }) })
  t.after(() => page.restore())
  await page.settled()

  assert.equal(page.feedback.section.hidden, true)
  assert.equal(page.feedback.send.listeners.click, undefined)
})

test('the door stays absent when this page has no fetch at all (a build with no /v1/ behind it)', async t => {
  const page = mount({}) // no fetchImpl -- mount() deletes globalThis.fetch for exactly this case
  t.after(() => page.restore())
  await page.settled()

  assert.equal(page.feedback.section.hidden, true)
  assert.equal(page.feedback.send.listeners.click, undefined)
})

test('pressing Send posts the typed message, and the build block rides only when the box is checked', async t => {
  const stub = feedbackFetchStub({ probe: { available: true } })
  const page = mount({}, { fetchImpl: stub })
  t.after(() => page.restore())
  await page.settled()

  /* Build info is present for BOTH presses, deliberately -- so the only
     thing that can decide whether the block appears is the checkbox
     itself. A build fact that is merely absent would make an unchecked and
     a checked press look identical for the wrong reason: `build` would be
     null either way and the includeBuild gate would never be exercised. */
  globalThis.mcBuildInfo = { appVersion: '1.0.34', shortCommit: 'abc1234' }
  t.after(() => { delete globalThis.mcBuildInfo })

  page.feedback.text.value = 'the export button is broken'
  page.feedback.build.checked = false
  await page.feedback.send.listeners.click()
  assert.equal(stub.posts.length, 1)
  assert.deepEqual(stub.posts[0], { message: 'the export button is broken' }, 'no build block when the box is unchecked')

  page.feedback.build.checked = true
  await page.feedback.send.listeners.click()
  assert.equal(stub.posts.length, 2)
  assert.match(stub.posts[1].message, /Version: 1\.0\.34/, 'the checked box must carry the build facts')
  assert.match(stub.posts[1].message, /Build: abc1234/)
})

test('the status line shows the honest sequence: sending, then sent -- and the button re-enables', async t => {
  const page = mount({}, { fetchImpl: feedbackFetchStub({ probe: { available: true }, submit: { received: true }, submitStatus: 202 }) })
  t.after(() => page.restore())
  await page.settled()

  page.feedback.text.value = 'hello'
  page.feedback.send.disabled = false
  const pending = page.feedback.send.listeners.click()
  /* SYNCHRONOUS UP TO THE FIRST AWAIT: the click handler sets disabled and
     the "sending" sentence before it ever awaits submitFeedback(), so both
     are already true the instant listeners.click() returns its promise --
     no sleep, no polling, exactly BAR 1's discrimination discipline. */
  assert.equal(page.feedback.send.disabled, true, 'a second press mid-send must not be possible')
  assert.equal(page.feedback.status.textContent, FEEDBACK_COPY.sending)
  assert.equal(page.feedback.status.hidden, false)

  await pending
  assert.equal(page.feedback.send.disabled, false, 'the button must re-enable once the round trip finishes')
  assert.equal(page.feedback.status.textContent, FEEDBACK_COPY.sent)
})

test('the status line tells the truth when the backend dies exactly at submit time', async t => {
  const page = mount({}, { fetchImpl: feedbackFetchStub({ probe: { available: true }, throwOnSubmit: true }) })
  t.after(() => page.restore())
  await page.settled()

  page.feedback.text.value = 'hello'
  await page.feedback.send.listeners.click()
  assert.equal(page.feedback.status.textContent, FEEDBACK_COPY.unavailable,
    'a door that opened on a live probe and then lost the backend must say so honestly, not claim success')
  assert.equal(page.feedback.send.disabled, false)
})

test('an empty message is refused locally and never reaches the network', async t => {
  const stub = feedbackFetchStub({ probe: { available: true } })
  const page = mount({}, { fetchImpl: stub })
  t.after(() => page.restore())
  await page.settled()

  page.feedback.text.value = '   '
  await page.feedback.send.listeners.click()
  assert.equal(stub.posts.length, 0, 'an empty message must never be posted')
  assert.equal(page.feedback.status.textContent, FEEDBACK_COPY.empty)
})

// ---------------------------------------------------------------------------
// THE SECTION IN ITS PLACE. Everything above drives the module on its own; the
// tests below mount the real Settings view and read what it drew, because the
// owner's request was not "write a module" -- it was "put it nicely into
// settings". Where the rows land, in what order, and what the section says
// about the one need nobody can clear are the parts a person actually meets.
//
// A SECOND STAND-IN, DELIBERATELY. mount() above models the DOM the MODULE
// reads. This one models the DOM the PAGE reads, and the two never collide:
// mount() saves whatever globals it finds and puts them back, so these survive.
// ---------------------------------------------------------------------------

let painted = ''
const settingsRows = new Map()
const settingsStore = new Map()

/* WHAT WAS PAINTED INTO EVERY SLOT, last write wins per node.
   The section's Install and Sign in controls do not exist in the markup the
   module builds: they are painted into a slot once the machine answers what is
   installed. A stand-in that dropped those writes would let the measuring test
   below count three controls for a section that draws sixteen, and would have
   made "it did not get shorter by doing less" unprovable. */
const paintedFragments = new Map()
let nodeSeq = 0
function settingsNode() {
  const self = {
    _id: (nodeSeq += 1),
    dataset: {}, value: '', checked: false, textContent: '', hidden: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: { setProperty() {}, getPropertyValue: () => '' },
    handlers: new Map(),
    addEventListener(type, handler) { this.handlers.set(type, handler) },
    removeEventListener() {},
    setAttribute() {}, removeAttribute() {}, toggleAttribute() {}, getAttribute: () => null,
    children: [], appendChild(child) { this.children.push(child); return child },
    querySelector: () => settingsNode(), querySelectorAll: () => [],
    closest: () => null, contains: () => true,
    getBoundingClientRect: () => ({ top: 0 }), getClientRects: () => [{ top: 0 }],
    /* RECORDED, not swallowed: "the page scrolled to the row the link named" is
       the whole claim of the deep-link test below, and a no-op stub would let a
       page that scrolled nowhere pass it. */
    scrolledInto: null,
    scrollIntoView(options) { this.scrolledInto = options ?? true },
    focus() {},
  }
  Object.defineProperty(self, 'innerHTML', {
    configurable: true,
    get: () => paintedFragments.get(self._id) ?? '',
    set(value) { paintedFragments.set(self._id, String(value)) },
  })
  return self
}

const settingsSections = settingsNode()
Object.defineProperty(settingsSections, 'innerHTML', {
  configurable: true,
  get: () => painted,
  set(value) {
    painted = String(value)
    settingsRows.clear()
    for (const match of painted.matchAll(/<article[^>]*data-setting-id="([^"]+)"[\s\S]*?<\/article>/g)) {
      settingsRows.set(match[1], settingsNode())
    }
  },
})
/* The rows this paint really drew, so markLanding() and scrollToLanding() reach
   the SAME node a test then reads. A fresh node per lookup would make every
   scroll unobservable, and this file would assert nothing about landing. */
settingsSections.querySelector = selector => {
  const id = selector.match(/^\[data-setting-id="([^"]+)"\]$/)?.[1]
  if (id) return settingsRows.get(id) ?? null
  return settingsNode()
}
settingsSections.querySelectorAll = () => []

const settingsRoot = settingsNode()
settingsRoot.querySelector = selector => (selector === '.settings-sections' ? settingsSections : settingsNode())
settingsRoot.querySelectorAll = () => []

/* Every template built while the page is up, in order. The first is the page
   frame; the rest are the elements src/this-computer-settings.js builds for the
   section, and the measuring test below needs them to count what the section
   really puts on screen rather than only its rows. */
const builtMarkup = []
globalThis.document = {
  createElement: () => ({ set innerHTML(value) { builtMarkup.push(String(value)) }, content: { firstElementChild: settingsRoot } }),
  documentElement: settingsNode(), body: settingsNode(), getElementById: () => null, querySelectorAll: () => [],
}
globalThis.localStorage = {
  getItem: key => settingsStore.get(key) ?? null,
  setItem: (key, value) => { settingsStore.set(key, String(value)) },
  removeItem: key => { settingsStore.delete(key) },
}
/* A MACHINE WITH NOTHING INSTALLED AND EVERY VERB CALLABLE. That is the state a
   copy is in the first time somebody opens this section, and it is the one that
   draws the most controls -- so the measuring test is not flattered by a bridge
   that answered nothing and painted nothing. */
globalThis.window = {
  addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
  matchMedia: () => ({ matches: false }),
  mcProviders: {
    presence: async () => ({ ok: true, providers: [
      { id: 'codex', installed: 'no', signedIn: 'no' },
      { id: 'claude', installed: 'no', signedIn: 'no' },
      { id: 'gemini', installed: 'no', signedIn: 'no' },
    ] }),
    installStart: async () => ({ ok: true }),
    loginStart: async () => ({ ok: true }),
    loginStop: async () => ({ ok: true }),
    accounts: async () => ({ ok: true, accounts: [] }),
    onLoginEvent: () => () => {},
  },
}
globalThis.CustomEvent = class CustomEvent {
  constructor(type, options = {}) { this.type = type; this.detail = options.detail }
}
globalThis.requestAnimationFrame = callback => { callback(); return 1 }
globalThis.cancelAnimationFrame = () => {}
/* NO REAL NETWORK FROM A UNIT TEST. Mounting the section probes the feedback
   backend, and this Node has a global fetch of its own, so an unstubbed run
   would have these tests reaching out to whatever host that resolves to.
   "Unavailable" is also the honest default here: it is what a copy with no
   backend behind it gets, which is the state every other assertion in this
   half assumes. */
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ available: false }) })

const { settingsView } = await import('../../src/views/settings.js')

function openSettings(setting) {
  painted = ''
  builtMarkup.length = 0
  paintedFragments.clear()
  return settingsView({ query: new URLSearchParams({ setting }), navigate: () => {} })
}

/* THE WORDS A PERSON ACTUALLY READS. Tags go, so title= and aria-label= are not
   counted as visible text; entities are decoded; whitespace collapses. */
function visibleWords(markup) {
  const text = String(markup)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
  return text.length === 0 ? [] : text.split(' ')
}

function countControls(markup) {
  return (markup.match(/<button\b/g) || []).length
    + (markup.match(/<input\b/g) || []).length
    + (markup.match(/<textarea\b/g) || []).length
    + (markup.match(/<select\b/g) || []).length
    + (markup.match(/<a\b/g) || []).length
}

/** Every row of the last paint, in order, with whether it was drawn hidden. */
function rowsDrawn() {
  return [...painted.matchAll(/<article[^>]*data-setting-id="([^"]+)"[^>]*>/g)]
    .map(match => ({ id: match[1], hidden: /\shidden(?=[\s>])/.test(match[0]) }))
}

async function settleReads() {
  for (let turn = 0; turn < 6; turn += 1) await new Promise(resolve => setImmediate(resolve))
}

test('the section is first in its group, and is the one a first arrival opens', () => {
  const group = SETTINGS_GROUPS.find(candidate => candidate.sections.includes(THIS_COMPUTER_SECTION))
  assert.ok(group, 'the section is in no group, so the rail has no door to it')
  assert.equal(group.sections[0], THIS_COMPUTER_SECTION,
    `${THIS_COMPUTER_SECTION} is not the first section of ${group.id}, so a person lands below something else`)
  assert.equal(FIRST_VISIT_SECTION, THIS_COMPUTER_SECTION,
    'a first visit no longer opens the section holding the Install and Sign in controls')
})

test('Settings draws the four rows in order, and the feedback row only once the backend answers', async t => {
  const priorFetch = globalThis.fetch
  t.after(() => {
    if (priorFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = priorFetch
  })
  /* FOUR ROWS, NOT FIVE. `this_computer_commands` was a row until 2026-09-10 and
     had no live state and no control -- it pointed at a description. It is a
     sentence in the section note now, and this list is the assertion that it
     did not quietly come back. */
  const ORDER = [
    THIS_COMPUTER_PROGRAMS_ROW,
    'this_computer_account',
    'this_computer_messaging',
    'this_computer_feedback',
  ]

  /* NO BACKEND AT ALL, which is the ordinary state of a copy nobody has
     connected anything to. The composer's row carries `hidden` from the first
     paint -- never a greyed "Send feedback", which would tell a person their
     report cannot be heard. */
  delete globalThis.fetch
  const bare = openSettings(THIS_COMPUTER_PROGRAMS_ROW)
  await settleReads()
  const withoutBackend = rowsDrawn()
  assert.deepEqual(withoutBackend.map(row => row.id), ORDER,
    'the section drew a different set of rows, or drew them in a different order')
  assert.equal(withoutBackend.at(-1).hidden, true,
    'the way to SEND something was offered although no backend has said it can be')
  for (const row of withoutBackend.slice(0, -1)) {
    assert.equal(row.hidden, false, `${row.id} was hidden, and nothing about it depends on a backend`)
  }
  bare.destroy()

  /* THE BACKEND ANSWERS YES, and the row appears -- which is the whole reason
     the answer re-renders the column rather than only unhiding a composer. */
  globalThis.fetch = feedbackFetchStub({ probe: { available: true } })
  const live = openSettings(THIS_COMPUTER_PROGRAMS_ROW)
  await settleReads()
  const withBackend = rowsDrawn()
  assert.deepEqual(withBackend.map(row => row.id), ORDER)
  assert.equal(withBackend.at(-1).hidden, false,
    'the backend said the door works and the row still did not appear')
  live.destroy()
})

/* READ BEFORE ANY READ SETTLES, and that is the point rather than a shortcut.
   Landing is a MOUNT-time behaviour: the section is drawn, the row is marked
   and the page arrives at it in one synchronous block, so that a person who
   followed a link is already looking at the row. Waiting first would prove
   something weaker -- and would in fact read the wrong nodes, because the
   feedback probe answering re-renders the column and builds new row elements
   under the ones this test is holding. */
test('a link that names the programs row opens that section and scrolls to the row', async () => {
  const view = openSettings(THIS_COMPUTER_PROGRAMS_ROW)
  try {
    assert.ok(painted.includes(`data-settings-section="${THIS_COMPUTER_SECTION}"`),
      `${THIS_COMPUTER_HREF} did not open the ${THIS_COMPUTER_SECTION} section`)
    const row = settingsRows.get(THIS_COMPUTER_PROGRAMS_ROW)
    assert.ok(row, 'the row the link named was not drawn on the page it opened')
    assert.deepEqual(row.scrolledInto, { behavior: 'auto', block: 'center' },
      'the page opened the right section but left the person to hunt for the row')
    /* And the address every other surface points at is this row's address, so a
       door somewhere else cannot drift from the row it opens. */
    assert.equal(THIS_COMPUTER_HREF, `#/settings?setting=${THIS_COMPUTER_PROGRAMS_ROW}`)
    /* And the mount's own reads are allowed to finish before the view is torn
       down, so nothing is left painting into a tree this test abandoned. */
    await settleReads()
  } finally {
    view.destroy()
  }
})

/* THE PROMISE THIS SECTION MAY NOT MAKE -- the rule of
   tools/test/first-run-needs.test.mjs, applied where the words are now shown.
   The need is FIRST_RUN_NEEDS `host`, whose fix is 'none': no setting connects
   an agent host and no command installs one. So the note must not offer a next
   step, and must carry no link, because a link here would be this page
   inventing an answer the product does not have. */
test('the section note carries the host sentence and promises no remedy for it', async () => {
  const view = openSettings(THIS_COMPUTER_PROGRAMS_ROW)
  try {
    await settleReads()
    const note = painted.match(new RegExp(`<p class="settings-section-note[^"]*" data-section-note="${THIS_COMPUTER_SECTION}">([\\s\\S]*?)</p>`))
    assert.ok(note, `the ${THIS_COMPUTER_SECTION} section drew no note at all`)
    const words = note[1]
    for (const forbidden of [
      /once (a|another) computer/i,
      /fills in on its own/i,
      /connect (a|another|your) computer/i,
      /install (an? )?agent host/i,
    ]) {
      assert.doesNotMatch(words, forbidden, `nothing in this copy may promise a remedy: ${forbidden}`)
    }
    assert.match(words, /None has reported to this copy\./,
      'the short note must state the observed absence of a fleet report')
    assert.doesNotMatch(words, /<a\b/,
      'the note offers a door for a need that has none anywhere in this product')

    /* The words are QUOTED from the copy modules, not retyped here, so this
       section cannot drift from what every other empty screen says. */
    const host = FIRST_RUN_NEEDS.find(need => need.id === 'host')
    assert.equal(host.fix, 'none')
    const escape = sentence => sentence.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    assert.ok(words.includes(escape(WORKS_HERE[2])) || words.includes(WORKS_HERE[2]),
      'the note stopped carrying the one sentence about what does work here')

    /* AND IT CARRIES THE GAP WITHOUT THE ESSAY. The need's body is six
       sentences: two name the gap, four reassure the reader about the product.
       A note is not the place to explain a product to somebody trying to use
       it, so only the opening survives. Asserted as a BOUND on how much of the
       body reaches the screen rather than by naming the sentences that went,
       which would go red against a better rewording of the copy module. */
    assert.ok(!words.includes(escape(host.body)) && !words.includes(host.body),
      'the whole host paragraph is back on screen; the note is an essay again')
    assert.ok(visibleWords(words).length < visibleWords(host.body).length,
      'the note is no shorter than the paragraph it was cut down from')
  } finally {
    view.destroy()
  }
})

/* HOW MUCH THERE IS TO READ, AS A RATCHET RATHER THAN AS A NOTE IN A REPORT.
 *
 * The owner asked for the page to become "more simple and useful", and then for
 * the result to be "significantly improved" rather than moved. Simple is a
 * measurable claim: the page this section replaced put 1727 visible words and
 * 44 paragraphs in front of somebody who had come to press Install. Nothing
 * stops that growing back one helpful sentence at a time, which is exactly how
 * it got to 1727, so the bound is asserted here.
 *
 * THE NUMBERS ARE CEILINGS WITH HEADROOM, NOT PINS. They are set above what the
 * section measures today, so an honest sentence can still be added; they are
 * far below the page, so the shape cannot come back. A row is allowed one
 * sentence, and a sentence over about forty words is not one sentence.
 */
test('the section stays small enough to be read at a glance', async () => {
  const view = openSettings(THIS_COMPUTER_PROGRAMS_ROW)
  try {
    await settleReads()
    /* The section is its rows and its note, plus the elements the module builds.
       builtMarkup[0] is the Settings page frame -- the rail, the search box, the
       footer -- which belongs to the page and not to this section. */
    const section = [painted, ...builtMarkup.slice(1), ...paintedFragments.values()].join('\n')
    const total = visibleWords(section).length
    const rows = [...painted.matchAll(/<article[^>]*data-setting-id="([^"]+)"[\s\S]*?<\/article>/g)]

    assert.equal(rows.length, 4, 'the section is not four rows any more')
    for (const row of rows) {
      const id = row[0].match(/data-setting-id="([^"]+)"/)[1]
      const count = visibleWords(row[0]).length
      assert.ok(count <= 40, `row ${id} reads ${count} visible words; a row is a name and one sentence`)
    }

    const note = painted.match(new RegExp(`data-section-note="${THIS_COMPUTER_SECTION}">([\\s\\S]*?)</p>`))
    assert.ok(note, 'the section note vanished')
    const noteWords = visibleWords(note[1]).length
    assert.ok(noteWords <= 90, `the section note reads ${noteWords} visible words; it is a note, not a page`)

    assert.ok(total <= 600,
      `the section reads ${total} visible words, and it read 409 when this bound was set. It is growing back into a page.`)

    /* AND IT IS NOT SMALL BY BEING EMPTY. The point was never fewer words: it
       was the same doors with less to read around them. A section that lost its
       controls would satisfy every bound above and be worse than the page.
       WHAT THIS FLOOR DOES AND DOES NOT COVER, said plainly rather than left to
       be discovered: it counts the controls in the section's OWN markup -- the
       three doors and the composer. The Install and Sign in buttons are painted
       into a slot after the machine answers, and this file's stand-in does not
       model that slot, so they are NOT in this number. They are covered by
       'sign-in controls are enabled only for available verbs and disabled
       controls carry reasons' in the first half of this file, which drives the
       real paint. The page-versus-section comparison is in REPORT.md, measured
       there by one script over both, because this file cannot render a page
       that no longer exists. */
    const controls = countControls(section)
    console.log(`[measured] rows=${rows.length} controls=${controls} noteWords=${noteWords} totalVisibleWords=${total}`)
    for (const row of rows) {
      console.log(`[measured] row ${row[0].match(/data-setting-id="([^"]+)"/)[1]} = ${visibleWords(row[0]).length} words`)
    }
    assert.ok(controls >= 7,
      `the section's own markup carries ${controls} controls, and it carried 7 when this floor was set: a door was lost`)
  } finally {
    view.destroy()
  }
})

test('repaint recovers a silent running install from snapshot and keeps Stop', async t => {
  const page = mount({
    presence: async () => ({ ok: true, providers: [{ id: 'codex', installed: 'no', signedIn: 'no' }] }),
    installStart: async () => ({ ok: true }),
    loginStop: async () => ({ ok: true, stopping: true, running: true, stopped: false }),
    installSnapshot: async () => ({ ok: true, known: true, provider: 'codex', state: 'running', op: 'install', lines: ['downloading tarball'], lastExit: null }),
    onLoginEvent: () => () => {},
  })
  t.after(() => page.restore())
  await page.settled()
  const { install, stop, log, status } = page.signIns.codex.fields
  assert.equal(stop.hidden, false, 'Stop vanished after a Settings repaint although the installer was still running')
  assert.equal(install.disabled, true)
  assert.match(log.textContent, /downloading tarball/)
  assert.match(status.textContent, /install/i)
  await stop.listeners.click()
  assert.equal(stop.hidden, false, 'Stop hid because kill was requested, not because the child exited')
})

test('a missing snapshot does not pretend the install completed', async t => {
  const page = mount({
    presence: async () => ({ ok: true, providers: [{ id: 'codex', installed: 'no', signedIn: 'no' }] }),
    installStart: async () => ({ ok: true }),
    loginStop: async () => ({ ok: true }),
  })
  t.after(() => page.restore())
  await page.settled()
  const { stop, log } = page.signIns.codex.fields
  assert.equal(stop.hidden, true)
  assert.equal(log.hidden, true)
})

test('login events after subscribe still paint, and a later snapshot does not drop them', async t => {
  let emit = null
  const page = mount({
    presence: async () => ({ ok: true, providers: [{ id: 'claude', installed: 'no', signedIn: 'no' }] }),
    installStart: async () => ({ ok: true }),
    loginStop: async () => ({ ok: true, stopping: true, running: true, stopped: false }),
    installSnapshot: async () => ({ ok: true, known: true, provider: 'claude', state: 'running', op: 'install', lines: ['started'], lastExit: null }),
    onLoginEvent: listener => { emit = listener; return () => {} },
  })
  t.after(() => page.restore())
  await page.settled()
  emit({ provider: 'claude', kind: 'line', text: 'still going' })
  assert.match(page.signIns.claude.fields.log.textContent, /still going/)
  applyInstallSnapshot(page.signIns.claude, {
    ok: true, known: true, provider: 'claude', state: 'running', op: 'install', lines: ['started'], lastExit: null,
  })
  assert.match(page.signIns.claude.fields.log.textContent, /started/)
  emit({ provider: 'claude', kind: 'exit', op: 'install', code: 1 })
  assert.equal(page.signIns.claude.fields.stop.hidden, true)
})

test('ordinary completed and failed snapshots stay distinct from unknown', () => {
  const panel = {
    stop: { hidden: true }, log: { hidden: true, textContent: '' }, status: { textContent: '' }, install: { disabled: false, title: '' },
    querySelector(selector) {
      return ({ '[data-signin-stop]': this.stop, '[data-signin-log]': this.log, '[data-signin-status]': this.status, '[data-signin-install]': this.install })[selector]
    },
  }
  applyInstallSnapshot(panel, null)
  assert.equal(panel.stop.hidden, true)
  applyInstallSnapshot(panel, { ok: true, known: true, state: 'failed', lines: ['npm ERR!'], lastExit: { code: 1 } })
  assert.equal(panel.stop.hidden, true)
  assert.match(panel.log.textContent, /npm ERR/)
  applyInstallSnapshot(panel, { ok: true, known: true, state: 'completed', lines: ['added 1 package'], lastExit: { code: 0 } })
  assert.equal(panel.stop.hidden, true, 'a completed snapshot must not invent a Stop control')
})

test('installer timeout snapshots retain cleanup controls and name the actual cause', async t => {
  const page = mount({
    presence: async () => ({ ok: true, providers: [{ id: 'codex', installed: 'no', signedIn: 'no' }] }),
    installStart: async () => ({ ok: true }), loginStop: async () => ({ ok: true }),
  })
  t.after(() => page.restore())
  await page.settled()
  const panel = page.signIns.codex
  applyInstallSnapshot(panel, { ok: true, known: true, state: 'stopping', timedOut: true,
    stopReason: 'timeout', cleanupUnconfirmed: true, lines: [] })
  assert.match(panel.fields.status.textContent, /time limit/)
  assert.equal(panel.fields.install.disabled, true)
  assert.equal(panel.fields.stop.hidden, false)
  applyInstallSnapshot(panel, { ok: true, known: true, state: 'failed', stopped: false,
    timedOut: true, stopReason: 'timeout', lines: [], lastExit: { code: null } })
  assert.match(panel.fields.status.textContent, /time limit.*Install.*try again/)
  assert.equal(panel.fields.install.disabled, false)
  assert.equal(panel.fields.stop.hidden, true)
  applyInstallSnapshot(panel, { ok: true, known: true, state: 'failed', stopped: true,
    stopReason: 'user', lines: [], lastExit: { code: null } })
  assert.doesNotMatch(panel.fields.status.textContent, /time limit/)
  assert.match(panel.fields.status.textContent, /stopped/)
})

test('installer timeout exit events explain retry without waiting for a snapshot', async t => {
  let emit
  const page = mount({
    presence: async () => ({ ok: true, providers: [{ id: 'codex', installed: 'no', signedIn: 'no' }] }),
    installStart: async () => ({ ok: true }), loginStop: async () => ({ ok: true }),
    onLoginEvent: listener => { emit = listener; return () => {} },
  })
  t.after(() => page.restore())
  await page.settled()
  emit({ provider: 'codex', kind: 'exit', op: 'install', code: null, timedOut: true, stopReason: 'timeout' })
  assert.match(page.signIns.codex.fields.status.textContent, /time limit.*Install.*try again/)
})

test('a delayed running snapshot cannot revive an installer that already exited', async t => {
  let answerFirst, emit, reads = 0
  const first = new Promise(resolve => { answerFirst = resolve })
  const page = mount({
    presence: async () => ({ ok: true, providers: [{ id: 'codex', installed: 'no', signedIn: 'no' }] }),
    installStart: async () => ({ ok: true }), loginStop: async () => ({ ok: true }),
    onLoginEvent: listener => { emit = listener; return () => {} },
    installSnapshot: () => ++reads === 1 ? first : Promise.resolve({ ok: true, known: true,
      state: 'failed', lines: ['download failed'], lastExit: { code: 1 } }),
  })
  t.after(() => page.restore())
  await page.settled()
  emit({ provider: 'codex', kind: 'exit', op: 'install', code: 1 })
  answerFirst({ ok: true, known: true, state: 'running', lines: ['downloading'], lastExit: null })
  await page.settled()
  assert.equal(page.signIns.codex.fields.stop.hidden, true)
  assert.equal(page.signIns.codex.fields.install.disabled, false, 'a failed installer must be retryable')
  assert.match(page.signIns.codex.fields.status.textContent, /without finishing/)
})

test('an event during snapshot recovery retains both old and newly printed lines', async t => {
  let answerFirst, emit, reads = 0
  const first = new Promise(resolve => { answerFirst = resolve })
  const page = mount({
    presence: async () => ({ ok: true, providers: [{ id: 'codex', installed: 'no', signedIn: 'no' }] }),
    installStart: async () => ({ ok: true }), loginStop: async () => ({ ok: true }),
    onLoginEvent: listener => { emit = listener; return () => {} },
    installSnapshot: () => ++reads === 1 ? first : Promise.resolve({ ok: true, known: true,
      state: 'running', lines: ['started before navigation', 'new progress'], lastExit: null }),
  })
  t.after(() => page.restore())
  await page.settled()
  emit({ provider: 'codex', kind: 'line', op: 'install', text: 'new progress' })
  answerFirst({ ok: true, known: true, state: 'running', lines: ['started before navigation'], lastExit: null })
  await page.settled()
  assert.equal(page.signIns.codex.fields.log.textContent, 'started before navigation\nnew progress\n')
})

test('returning after a completed install restores its completed state and log', async t => {
  const page = mount({
    presence: async () => ({ ok: true, providers: [{ id: 'codex', installed: 'yes', signedIn: 'no' }] }),
    installStart: async () => ({ ok: true }), loginStop: async () => ({ ok: true }),
    installSnapshot: async () => ({ ok: true, known: true, state: 'completed', lines: ['added 2 packages'], lastExit: { code: 0 } }),
  })
  t.after(() => page.restore())
  await page.settled()
  assert.equal(page.signIns.codex.fields.stop.hidden, true)
  assert.equal(page.signIns.codex.fields.install.disabled, false)
  assert.match(page.signIns.codex.fields.log.textContent, /added 2 packages/)
  assert.match(page.signIns.codex.fields.status.textContent, /finished/)
})

test('Stop cannot restore running controls after the exit event already arrived', async t => {
  let emit, stopped = false
  const page = mount({
    presence: async () => ({ ok: true, providers: [{ id: 'codex', installed: 'no', signedIn: 'no' }] }),
    installStart: async () => ({ ok: true }),
    onLoginEvent: listener => { emit = listener; return () => {} },
    loginStop: async () => { stopped = true; emit({ provider: 'codex', kind: 'exit', op: 'install', code: null }); return { ok: true, stopped: true, running: false } },
    installSnapshot: async () => ({ ok: true, known: true, state: stopped ? 'failed' : 'running', lines: [], lastExit: stopped ? { code: null } : null }),
  })
  t.after(() => page.restore())
  await page.settled()
  await page.signIns.codex.fields.stop.listeners.click()
  await page.settled()
  assert.equal(page.signIns.codex.fields.stop.hidden, true)
  assert.equal(page.signIns.codex.fields.install.disabled, false)
})

/* NO SECOND COPY, AND SAY WHICH COPY IS USED (rc-0922, the owner: "right now do
   we aggressively try to write over a users paths or such? Can we do a better
   job at install time?"). A program the machine reports installed used to keep
   an Install button that put a second copy on the computer; now the copy you
   have is used, the button offers only the explicit choice of a private copy
   in ToolsEnabled's own folder, and one line says which copy runs, whose it is
   and its version -- never a path. */
test('a program already on this computer is used, and its button offers only a private copy', async t => {
  const asked = []
  const page = mount({
    presence: async () => ({ ok: true, providers: [
      { id: 'claude', installed: 'yes', signedIn: 'yes' },
      { id: 'codex', installed: 'no', signedIn: 'no' },
    ] }),
    installStart: async request => { asked.push(request); return { ok: true } },
    toolchainStatus: async () => ({ ok: true, available: true, providers: [
      { id: 'claude', client: null, installed: 'yes', channel: 'native', owner: 'person', version: '2.1.280', copies: 2,
        others: [{ channel: 'npm-global', owner: 'person', version: '2.1.270' }], features: 'unknown', updateCommand: 'claude update' },
    ] }),
  })
  t.after(() => page.restore())
  await page.settled()
  await page.settled()

  const claude = page.signIns.claude
  assert.doesNotMatch(claude.markup, /Install Claude/, 'an installed program still offered to install a second copy')
  assert.match(claude.markup, /Use a private copy/)
  assert.match(claude.markup, /already on this computer, and ToolsEnabled uses it/)
  await claude.fields.install.listeners.click()
  assert.deepEqual(asked, [{ provider: 'claude', privateCopy: true }], 'the only install left for an installed program is an explicit private copy')
  assert.equal(claude.fields.copy.hidden, false)
  assert.equal(claude.fields.copy.textContent,
    "Version 2.1.280, installed by its maker's own installer. 2 copies are on this computer; ToolsEnabled uses this one. To update it, run claude update in a terminal.")

  const codex = page.signIns.codex
  assert.match(codex.markup, /Install Codex/, 'a program that is not here keeps its Install button')
  await codex.fields.install.listeners.click()
  assert.deepEqual(asked.at(-1), { provider: 'codex' })
})

test('the copy line is words and a version, and stays empty without an answer', () => {
  assert.equal(copyLineFor({ id: 'claude', client: null, installed: 'yes', channel: 'toolsenabled', owner: 'toolsenabled', version: '2.1.281', copies: 1, updateCommand: null }),
    'Version 2.1.281, installed by ToolsEnabled in its own folder.')
  assert.equal(copyLineFor({ id: 'codex', client: null, installed: 'yes', channel: 'npm-global', owner: 'person', version: null, copies: 1, updateCommand: 'npm install -g @openai/codex@latest' }),
    'Installed with npm. To update it, run npm install -g @openai/codex@latest in a terminal.')
  assert.equal(copyLineFor(null), '')
  assert.equal(copyLineFor({ id: 'claude', installed: 'no' }), '')
  assert.equal(copyLineFor({ id: 'gemini', client: 'antigravity', installed: 'yes', channel: 'native' }), '')
})
