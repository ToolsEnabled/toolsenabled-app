/* THE THREE THINGS THE PAGE HAS TO GET RIGHT ABOUT NOTIFICATIONS.
 *
 *   1  A switch that cannot succeed is DISABLED WITH THE REASON BESIDE IT.
 *      These two rows are switches over something outside this window -- the
 *      operating system's notification service, reached through the installed
 *      application -- and there are two states in which turning one on would
 *      change nothing: this page open in a browser, and a computer whose
 *      Electron says it shows no notifications. Left live, the row would save a
 *      choice and never produce a notification, which is the drawn-control
 *      defect tools/test/settings-rows-do-something.test.mjs exists over.
 *      Hidden, a person hunting for a notification setting would conclude the
 *      product has none.
 *
 *   2  THE REASON IS WHERE THE EYE IS. A title attribute is a reason only a
 *      mouse can find. So the reason is printed where the description goes as
 *      well, which is what the example-fleet row already does.
 *
 *   3  THE PAGE SAYS WHAT IT IS SHOWING, so the main process can stay quiet
 *      while somebody is already watching that agent. Driven here against the
 *      real live-session registry: publishing a session reports it, and tearing
 *      the surface down reports that nothing is on screen.
 *
 * The page is driven through its exported view with the same URLSearchParams
 * src/main.js hands it, and the markup it painted is read back -- so this is
 * the row a person would have seen, not a private helper.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import test, { after, afterEach } from 'node:test'
import { fetchAgents, fetchCoordinator, fetchProjection } from '../../src/live-status.js'

register('./helpers/css-stub-loader.mjs', import.meta.url)

/* Settings also mounts Home agent discovery. Serve its two read-only domains
 * from synthetic unavailable envelopes and the actual static schemas, without
 * giving this notification fixture a network dependency or invented agents.
 * Unexpected reads fail even when the product catches a transport rejection. */
function discoveryFixture() {
  const routes = new Map()
  for (const domain of ['agents', 'coordinator']) {
    routes.set(`/data/${domain}.json`, {
      schemaVersion: 1, domain, generatedAt: '2026-09-08T00:00:00.000Z',
      ok: false, reason: 'notification-fixture-has-no-live-agents', sources: [], data: null,
    })
    routes.set(`/data/schema/${domain}.schema.json`, JSON.parse(readFileSync(
      new URL(`../../public/data/schema/${domain}.schema.json`, import.meta.url), 'utf8',
    )))
  }
  const calls = [], unexpected = []
  return {
    calls, unexpected,
    async fetch(url, options) {
      calls.push(url)
      try {
        assert.ok(routes.has(url), `Unexpected notification fixture request: ${url}`)
        assert.deepEqual(options, { cache: 'no-store' }, 'Discovery must remain a read-only uncached request')
      } catch (error) {
        unexpected.push(url)
        throw error
      }
      return { ok: true, status: 200, statusText: 'OK', json: async () => structuredClone(routes.get(url)) }
    },
    assertOnlyExpected() {
      assert.deepEqual(unexpected, [], 'The Settings fixture attempted an undeclared request')
    },
  }
}
const discovery = discoveryFixture()
const previousFetch = globalThis.fetch
globalThis.fetch = discovery.fetch
afterEach(() => discovery.assertOnlyExpected())
after(() => { globalThis.fetch = previousFetch })

const stored = new Map()
const listeners = new Map()
let painted = ''

const classList = () => ({ add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false })

function node() {
  return {
    dataset: {}, value: '', checked: false, textContent: '', hidden: false,
    children: [], appendChild(child) { this.children.push(child); return child },
    classList: classList(),
    style: { setProperty: () => {}, getPropertyValue: () => '' },
    addEventListener: () => {}, removeEventListener: () => {},
    setAttribute: () => {}, removeAttribute: () => {}, toggleAttribute: () => {},
    getAttribute: () => null, querySelector: () => node(), querySelectorAll: () => [],
    closest: () => null, contains: () => true,
    getBoundingClientRect: () => ({ top: 0 }), getClientRects: () => [{ top: 0 }], scrollIntoView: () => {}, focus: () => {},
  }
}

const sections = node()
// A category without these sockets must not create the This Computer
// controller (or its feedback read). querySelector returns null for absence.
sections.querySelector = selector => {
  if (selector.startsWith('[data-settings-mount=')) {
    const attribute = selector.slice(1, -1)
    return painted.includes(attribute) ? node() : null
  }
  return node()
}
Object.defineProperty(sections, 'innerHTML', {
  get: () => painted,
  set: value => { painted = String(value) },
})

const root = node()
root.querySelector = selector => selector === '.settings-sections' ? sections : node()

globalThis.document = {
  createElement: () => ({
    set innerHTML(value) { this.value = value },
    content: { firstElementChild: root },
  }),
  documentElement: node(), body: node(), getElementById: () => null,
}
globalThis.localStorage = {
  getItem: key => stored.get(key) ?? null,
  setItem: (key, value) => { stored.set(key, String(value)) },
  removeItem: key => { stored.delete(key) },
}
globalThis.window = {
  addEventListener: (type, listener) => {
    const group = listeners.get(type) || new Set()
    group.add(listener)
    listeners.set(type, group)
  },
  removeEventListener: (type, listener) => listeners.get(type)?.delete(listener),
  dispatchEvent: event => {
    for (const listener of listeners.get(event.type) || []) listener(event)
    return true
  },
  matchMedia: () => ({ matches: false }),
}
globalThis.CustomEvent = class CustomEvent {
  constructor(type, options = {}) { this.type = type; this.detail = options.detail }
}
globalThis.requestAnimationFrame = callback => { callback(); return 1 }
globalThis.cancelAnimationFrame = () => {}

const {
  COMPUTER_SHOWS_NONE,
  NO_INSTALLED_APPLICATION,
  notificationDelivery,
} = await import('../../src/notification-delivery.js')
const { startAttentionReports } = await import('../../src/notification-attention.js')
const { publishLiveSession, resetLiveSessionForTest } = await import('../../src/agent-session-registry.js')
const { settingsView } = await import('../../src/views/settings.js')

const NOTIFY_ROWS = ['notify_agent_finished', 'notify_agent_error']

function rowMarkup(id) {
  const row = new RegExp(`<article[^>]*data-setting-id="${id}"[\\s\\S]*?</article>`).exec(painted)
  assert.ok(row, `Settings did not draw the ${id} row`)
  return row[0]
}

function control(id) {
  const input = /<input type="checkbox"[^>]*>/.exec(rowMarkup(id))
  assert.ok(input, `the ${id} row has no switch`)
  return input[0]
}

/* THE DESCRIPTION NODE ALONE, AND THIS IS THE WHOLE POINT OF THE HELPER.
 *
 * The claim these tests certify is that a disabled switch's reason is printed
 * WHERE THE DESCRIPTION GOES and not only in a title attribute a mouse has to
 * find. An earlier version of the test below asserted the reason against
 * rowMarkup(), which is the whole <article> -- and the article contains the
 * control, and the control carries `title="…Install ToolsEnabled to turn these
 * on."`. So it passed on the title alone: it was satisfied by the exact thing it
 * was written to reject, and deleting the branch in rowDescription() left it
 * green. Reviewed and proved on 2026-08-27. Every assertion about what a reader
 * SEES goes through this function. */
function description(id) {
  const found = /<div class="settings-desc"[^>]*>([\s\S]*?)<\/div>/.exec(rowMarkup(id))
  assert.ok(found, `the ${id} row has no description`)
  /* And the extraction must not be quietly reading the control instead. */
  assert.doesNotMatch(found[1], /<input|title=/, `the ${id} description grabbed the control too, so this test would pass on a title`)
  return found[1]
}

function draw() {
  const view = settingsView({ query: new URLSearchParams({ setting: 'notify_agent_finished' }) })
  view.destroy()
}

/* ---------- 1. WHAT THE PAGE CAN ESTABLISH ---------- */

test('the discovery fixture serves only its declared synthetic projections', async () => {
  const fixture = discoveryFixture()
  for (const [domain, read] of [['agents', fetchAgents], ['coordinator', fetchCoordinator]]) {
    const result = await read({ fetchImpl: fixture.fetch })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'notification-fixture-has-no-live-agents')
    assert.equal(result.data.domain, domain, 'The actual schema reader must accept the synthetic envelope')
    assert.equal(result.data.data, null, 'Unavailable discovery must not invent a cast')
  }
  assert.deepEqual(fixture.calls, [
    '/data/agents.json', '/data/schema/agents.schema.json',
    '/data/coordinator.json', '/data/schema/coordinator.schema.json',
  ])
  fixture.assertOnlyExpected()
  await assert.rejects(fixture.fetch('https://example.invalid/', { cache: 'no-store' }), /Unexpected/)
  await assert.rejects(fixture.fetch('/data/agents.json', { cache: 'no-store', method: 'POST' }), /read-only/)
  const refused = await fetchProjection('metrics', { fetchImpl: fixture.fetch })
  assert.equal(refused.ok, false, 'A caller swallowing a rejection must still leave a refusal')
  assert.deepEqual(fixture.unexpected, [
    'https://example.invalid/', '/data/agents.json', '/data/metrics.json', '/data/schema/metrics.schema.json',
  ])
  assert.throws(() => fixture.assertOnlyExpected(), /undeclared request/,
    'The fixture check must catch unexpected requests even after the product catches them')
})

test('the delivery answer is believed only when it is the word true', () => {
  assert.deepEqual(notificationDelivery(null), { supported: false, why: NO_INSTALLED_APPLICATION })
  assert.deepEqual(notificationDelivery({ supported: false }), { supported: false, why: COMPUTER_SHOWS_NONE })
  /* The two sentences must not be the same one wearing two hats: "there is no
     installed application here" and "this computer shows no notifications" are
     different facts and a person acts on them differently. */
  assert.notEqual(NO_INSTALLED_APPLICATION, COMPUTER_SHOWS_NONE)
  /* Every not-quite-true answer is could-not-establish, and could-not-establish
     draws the disabled switch. A bridge from an older shell answers undefined
     here; a refused sender answers a record. Neither is "it works". */
  for (const answer of [{}, { supported: 'true' }, { supported: 1 }, { supported: null }]) {
    assert.equal(notificationDelivery(answer).supported, false, `${JSON.stringify(answer)} was read as a working notification service`)
  }
  assert.deepEqual(notificationDelivery({ supported: true }), { supported: true, why: null })

  /* THE TWO SENTENCES ARE COMPARED TO THE PAINTED MARKUP CHARACTER FOR
     CHARACTER by the row tests below, which is only sound while neither of
     them contains anything the page's escaping would rewrite. If one ever
     gains an apostrophe or an ampersand, this line is what says so, rather
     than a row test failing with a diff nobody can read. */
  for (const sentence of [NO_INSTALLED_APPLICATION, COMPUTER_SHOWS_NONE]) {
    assert.doesNotMatch(sentence, /[&<>"']/, 'this sentence now contains a character the page escapes; compare against the escaped form')
  }
})

/* ---------- 2. THE ROWS ----------
 *
 * The global-reading path -- `notificationDelivery()` with no argument, which
 * is how the settings page calls it -- is driven by the three tests below
 * rather than here: each sets window.mcNotify and then reads back the markup
 * the page actually painted. */

test('a notification switch that cannot succeed is disabled, and says why where the eye is', () => {
  stored.clear()
  globalThis.window.mcNotify = undefined
  draw()

  for (const id of NOTIFY_ROWS) {
    const input = control(id)
    assert.match(input, /\sdisabled(?=[\s/>])/, `${id} stayed pressable with no installed application to raise anything`)
    const why = /\stitle="([^"]+)"/.exec(input)?.[1]
    assert.equal(typeof why, 'string', `${id} is disabled and carries no reason`)
    assert.match(why, /installed application/i, `${id} does not say what is missing`)
    /* AND IN THE DESCRIPTION, where a reader who never hovers will find it.
       Asserted against the description NODE, not the article -- see the helper.
       The whole sentence, so a row printing half of it is a failure. */
    assert.equal(description(id), NO_INSTALLED_APPLICATION,
      `${id} keeps a reason only a mouse could find`)
    /* And the row's ordinary description is GONE from that node rather than
       sitting under a dead switch still promising what it would do. */
    assert.doesNotMatch(description(id), /Your computer shows a short notification/,
      `${id} advertises what it would do underneath a switch that cannot do it`)
  }
})

test('a computer that shows no notifications gets its own sentence, not the browser one', () => {
  stored.clear()
  globalThis.window.mcNotify = { supported: false, watching: () => Promise.resolve({ ok: true }) }
  draw()

  for (const id of NOTIFY_ROWS) {
    const why = /\stitle="([^"]+)"/.exec(control(id))?.[1]
    assert.match(control(id), /\sdisabled(?=[\s/>])/, `${id} stayed pressable on a computer that shows no notifications`)
    assert.match(why, /does not show notifications from a program/i, `${id} gave the wrong reason`)
    assert.equal(description(id), COMPUTER_SHOWS_NONE,
      `${id} printed the wrong sentence where a reader will actually find it`)
  }
})

test('on a computer that can show them the switches are live, and ship off', () => {
  stored.clear()
  globalThis.window.mcNotify = { supported: true, watching: () => Promise.resolve({ ok: true }) }
  draw()

  for (const id of NOTIFY_ROWS) {
    const input = control(id)
    assert.doesNotMatch(input, /\sdisabled(?=[\s/>])/, `${id} was disabled on a computer that can show notifications`)
    assert.doesNotMatch(input, /\schecked/, `${id} is switched ON with nothing stored, so this product opts people into interruptions`)
    assert.match(rowMarkup(id), /Off\./, `${id} does not tell a reader its current state`)
    /* THE OTHER HALF OF THE DISABLED TESTS. A row that can work says what it
       does, and says NEITHER of the two "this cannot work here" sentences --
       so a branch that printed the reason unconditionally is caught here, and
       a branch that never printed it is caught above. */
    assert.match(description(id), /^Your computer shows a short notification/,
      `${id} does not say what it does on a computer where it works`)
    for (const reason of [NO_INSTALLED_APPLICATION, COMPUTER_SHOWS_NONE]) {
      assert.doesNotMatch(description(id), new RegExp(reason.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `${id} says it cannot work on a computer where it can`)
    }
  }

  /* THE STOP ROW HAS TO NAME BOTH ENDINGS IT GOVERNS. It was wired to a failed
     turn alone when it landed, while its sentence -- "when an agent stops
     before it finishes" -- also covers an engine whose program went away with
     no turn running. Half a governed row is the drawn-control defect in its
     partial form, so the row now says which stops it means and
     tools/test/agent-notifications.test.mjs drives both. */
  assert.match(description('notify_agent_error'), /a turn that ended badly and an agent whose program went away/,
    'the stop row does not say which stops it covers')

  /* And a stored choice is read back, so the switch shows the truth rather than
     the default. */
  stored.set('mc.set.notify_agent_finished', 'true')
  draw()
  assert.match(control('notify_agent_finished'), /\schecked/, 'a switched-on row drew itself off')
  assert.doesNotMatch(control('notify_agent_error'), /\schecked/, 'one row switched on the other')
})

test('the section says the two things a person cannot work out from the switches', () => {
  stored.clear()
  globalThis.window.mcNotify = { supported: true, watching: () => Promise.resolve({ ok: true }) }
  draw()
  const note = /<p class="settings-section-note[^>]*data-section-note="Notifications"[^>]*>([\s\S]*?)<\/p>/.exec(painted)
  assert.ok(note, 'the Notifications section carries no note')
  assert.match(note[1], /skipped while this window has focus/,
    'the section does not say when a notification will deliberately not appear')
  /* The one a person would otherwise hunt for. Agents DO stop to ask when Tool
     use approvals or Setup's "Stop and wait for me" are on (T1484), but no
     notification is raised for those questions yet, so there is no switch for
     it; saying so costs a sentence and leaving it out costs somebody the
     search. The old sentence claimed agents never stop to ask at all. */
  assert.match(note[1], /stops to ask for your approval does not raise a notification yet/,
    'the section does not say why there is no approval switch')
  assert.doesNotMatch(note[1], /never stop to ask/,
    'the section claims agents never stop to ask, which approvals and Setup contradict')
})

/* ---------- 3. THE REPORT ---------- */

test('the page reports the session on screen, and reports when there is none', () => {
  resetLiveSessionForTest()
  const reported = []
  const bridge = { supported: true, watching: request => { reported.push(request); return Promise.resolve({ ok: true }) } }

  const stop = startAttentionReports({ bridge })
  /* REPORTED IMMEDIATELY. A window reloaded while a session is running would
     otherwise report nothing until that session next changed state -- and
     "nothing on screen" is the answer that delivers, so that window would
     interrupt somebody reading a transcript. */
  assert.deepEqual(reported, [{ sessionId: null }])

  const control = { pause: () => {}, respawn: () => {}, terminate: () => {} }
  publishLiveSession({ agentId: 'agent-a', sessionId: 'session-1', phase: 'open', control })
  assert.deepEqual(reported.at(-1), { sessionId: 'session-1' }, 'the page did not report the session it put on screen')

  /* The registry announces every phase change; they are all the same answer to
     the only question being asked, so they cost one call, not four. */
  const before = reported.length
  publishLiveSession({ agentId: 'agent-a', sessionId: 'session-1', phase: 'working', control })
  publishLiveSession({ agentId: 'agent-a', sessionId: 'session-1', phase: 'stopping', control })
  assert.equal(reported.length, before, 'a phase change re-reported a session that had not changed')

  /* LEAVING THE AGENT PAGE. src/agent-session.js clears the record in its own
     teardown -- "the record goes with the surface" -- so this is what a
     navigation looks like from here. */
  publishLiveSession(null)
  assert.deepEqual(reported.at(-1), { sessionId: null }, 'walking away from the agent page still reported it as on screen')

  publishLiveSession({ agentId: 'agent-a', sessionId: 'session-2', phase: 'open', control })
  stop()
  assert.deepEqual(reported.at(-1), { sessionId: null }, 'the window went and left a session reported as on screen')
  const after = reported.length
  publishLiveSession({ agentId: 'agent-a', sessionId: 'session-3', phase: 'open', control })
  assert.equal(reported.length, after, 'the report kept running after it was stopped')
  resetLiveSessionForTest()
})

test('the page going away reports that nothing is on screen, without anyone calling stop', () => {
  /* WHY THIS TEST EXISTS. src/main.js mounts the reports once for the life of
     the window and throws the returned stop function away -- correctly, because
     this is a fact about the window and not about a route. That left the branch
     that says "nothing is on screen any more" reachable only from a suite,
     which is a teardown with no production caller: on a reload the main process
     would go on believing a transcript was in front of somebody until the new
     page reported. The page's own `pagehide` is the production caller now, and
     this drives it through a page object that behaves like the real one. */
  resetLiveSessionForTest()
  const reported = []
  const bridge = { supported: true, watching: request => { reported.push(request); return Promise.resolve({ ok: true }) } }
  const handlers = new Map()
  const page = {
    addEventListener: (type, listener) => { handlers.set(type, listener) },
    removeEventListener: (type, listener) => { if (handlers.get(type) === listener) handlers.delete(type) },
  }
  const control = { pause: () => {}, respawn: () => {}, terminate: () => {} }

  const stop = startAttentionReports({ bridge, page })
  publishLiveSession({ agentId: 'agent-a', sessionId: 'session-1', phase: 'open', control })
  assert.deepEqual(reported.at(-1), { sessionId: 'session-1' })

  const onPageHide = handlers.get('pagehide')
  assert.equal(typeof onPageHide, 'function', 'nothing in the product tells this that the page is going')
  onPageHide()
  assert.deepEqual(reported.at(-1), { sessionId: null }, 'the page went and left a session reported as on screen')

  /* And it really stopped: the subscription is gone and the listener with it. */
  const after = reported.length
  publishLiveSession({ agentId: 'agent-a', sessionId: 'session-2', phase: 'open', control })
  assert.equal(reported.length, after, 'the report kept running after the page went')
  assert.equal(handlers.has('pagehide'), false, 'the listener outlived the page it was watching')

  /* Whoever still holds the returned function may call it, and it must not
     report a second time -- a second null is a claim that something changed. */
  stop()
  assert.equal(reported.length, after, 'stopping twice reported twice')
  resetLiveSessionForTest()
})

test('a bridge that is absent or refuses costs the report, never the page', () => {
  resetLiveSessionForTest()
  const control = { pause: () => {}, respawn: () => {}, terminate: () => {} }

  assert.doesNotThrow(() => startAttentionReports({ bridge: null })())
  assert.doesNotThrow(() => startAttentionReports({ bridge: {} })())

  const stop = startAttentionReports({ bridge: { watching: () => { throw new Error('the bridge is gone') } } })
  assert.doesNotThrow(() => publishLiveSession({ agentId: 'a', sessionId: 's', phase: 'open', control }))
  assert.doesNotThrow(stop)
  resetLiveSessionForTest()
})
