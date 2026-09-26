/* THE OLD ADDRESS OF THE PAGE THAT IS NOW A SECTION OF SETTINGS, AND THE ONE
 * WAY IT CAN FAIL SILENTLY.
 *
 * WHAT THIS FILE IS FOR, stated as the defect rather than the feature. The page
 * called "What this copy needs" lived at `#/guide` and six screens carried a
 * door to it. It is a section of Settings now. If the router simply stopped
 * knowing `#/guide`, the address would not error and would not blank: this
 * router resolves an address it does not know to HOME. So every one of those
 * doors -- and every older refusal sentence that names the address, and every
 * link a reader wrote down -- would become a control that silently throws the
 * person back where they started. That is worse than a missing door, because a
 * person presses it twice before they stop believing the screen, and nothing
 * anywhere reports it.
 *
 * It is asserted here rather than in a browser because src/main.js cannot be
 * imported by a node test: it pulls in every view and every stylesheet and then
 * mounts the application. src/route-parse.js is the same table as a pure
 * function, and src/main.js calls it.
 *
 * NOTHING HERE PINS A SPELLING. The row id is read from GUIDE_HREF -- the one
 * constant every door in the product links through -- so moving the row moves
 * the alias and this file with it, and a BETTER row id passes. What is pinned
 * is the property: the address a reader already has lands on the same row the
 * doors land on, and never on home.
 *
 * Run: node --test tools/test/guide-route-alias.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { parseRoute } from '../../src/route-parse.js'
import { GUIDE_HREF, SETTINGS_HREF } from '../../src/first-run-needs.js'

const settingOf = href => new URLSearchParams(href.slice(href.indexOf('?') + 1)).get('setting')

test('the old guide address resolves to the settings stop, at the row the doors name', () => {
  const route = parseRoute('#/guide')
  assert.equal(route.name, 'settings', 'an address six screens link to resolves somewhere else')
  assert.equal(route.query.get('setting'), 'this_computer_programs')
  /* And it is the SAME row every door leads to. A door and an alias that drift
     apart is two answers to one question, and the reader meets whichever one
     they happened to press. */
  assert.equal(route.query.get('setting'), settingOf(GUIDE_HREF))
})

test('it never falls to home, which is how this would fail without anybody noticing', () => {
  /* The router's rule for an address it does not know. Asserted here so the
     contrast is on the record: `#/guide` must not behave like this. */
  assert.equal(parseRoute('#/no-such-stop').name, 'home')
  assert.notEqual(parseRoute('#/guide').name, 'home')
})

test('the door itself is an address this router can resolve', () => {
  /* GUIDE_HREF is what six screens put in an href. A constant naming a stop the
     router does not know is the same dead end wearing a different spelling. */
  const viaDoor = parseRoute(GUIDE_HREF)
  assert.equal(viaDoor.name, 'settings')
  assert.equal(viaDoor.query.get('setting'), settingOf(GUIDE_HREF))
  assert.ok(GUIDE_HREF.startsWith(`${SETTINGS_HREF}?`), `the door does not open Settings: ${GUIDE_HREF}`)
})

/* ------------------------------------------------------------------
   The rest of the table, because this function was lifted out of src/main.js
   and a lift that quietly changed one other stop would be invisible.
   ------------------------------------------------------------------ */

test('every other stop resolves the way it did before this table moved', () => {
  assert.equal(parseRoute('#/').name, 'home')
  assert.equal(parseRoute('#/metrics').name, 'metrics')
  assert.equal(parseRoute('#/research').name, 'research')
  assert.equal(parseRoute('#/comms').name, 'comms')
  assert.equal(parseRoute('#/checkout').name, 'checkout')
  assert.equal(parseRoute('#/tools').name, 'tools')
  assert.equal(parseRoute('#/setup').name, 'setup')
  assert.equal(parseRoute('#/account').name, 'account')
  assert.equal(parseRoute('#/subscribe').name, 'subscribe')
  /* `pricing` is what a stranger types and it reaches the same surface. */
  assert.equal(parseRoute('#/pricing').name, 'subscribe')

  const computers = parseRoute('#/computers/machine-a')
  assert.equal(computers.name, 'computers')
  assert.equal(computers.comp, 'machine-a')
  assert.equal(parseRoute('#/computers').comp, null)

  /* T302: the #/agent drill-in is retired -- src/views/agent.js still exists
     (its own witness suites still read it), but no hash resolves to it any
     more, exactly like any other address this table does not know. Every
     shape that used to reach it -- three segments, the /example suffix, or
     too few segments to ever have been a drill-in -- lands on home alike. */
  assert.equal(parseRoute('#/agent/machine-a/circle-b/example').name, 'home')
  assert.equal(parseRoute('#/agent/machine-a/circle-b').name, 'home')
  assert.equal(parseRoute('#/agent/machine-a').name, 'home')
})

test('a settings address carries its query, so a link can still name one row', () => {
  const named = parseRoute('#/settings?setting=write_agent-session')
  assert.equal(named.name, 'settings')
  assert.equal(named.query.get('setting'), 'write_agent-session')
  /* And a plain address still lands where it always did, naming nothing. */
  assert.equal(parseRoute('#/settings').query.get('setting'), null)
})

test('the ledger entry choice is reported once, and only for a list that exists', () => {
  /* This is the one stop whose parse has a consequence: `?tab=` is an ENTRY
     choice a link may make, consumed once and then removed from the address so
     a later read does not drag the person back off the list they chose. The
     pure table reports the decision; src/main.js is the only place that writes. */
  const chosen = parseRoute('#/ledger?tab=t&keep=1')
  assert.equal(chosen.name, 'ledger')
  assert.equal(chosen.tab, 't')
  assert.equal(chosen.rest, 'keep=1', 'the rest of the address was thrown away with the tab')

  /* A tab nobody offers is not a choice. It must not be stored and must not
     rewrite the address, because a value read from a hash is untrusted. */
  const nonsense = parseRoute('#/ledger?tab=zzz')
  assert.equal(nonsense.tab, null)
  assert.equal(nonsense.rest, '')
  assert.equal(parseRoute('#/ledger').tab, null)

  /* `#/approvals` is the same list entered by its own name. */
  const approvals = parseRoute('#/approvals')
  assert.equal(approvals.name, 'ledger')
  assert.equal(approvals.tab, 'p')
})

test('an absent or unusable hash is home rather than a crash', () => {
  /* location.hash is '' on a fresh window, and this function is also reached
     from a drawer read that may hand it nothing at all. */
  for (const value of ['', undefined, null, '#/']) {
    assert.equal(parseRoute(value).name, 'home', `${JSON.stringify(value)} did not resolve to home`)
  }
})

/* ---------- where the door lands (T1411, T1594) ----------
   The door's row, Assistant programs, is about 2,100 px tall. Centred, its
   heading and the whole Codex block sat above the window and focus went to an
   'Install Codex' 407 px above the top edge (T1411). Rows that fill in their
   controls a moment after the page paints (Join this computer, this same row)
   got one try at focus on the first frame and then none, so focus stayed on the
   page body (T1594). These drive src/settings-landing.js, which the Settings
   view lands every ?setting= row through, with a stand-in page whose geometry
   follows the scroll the landing asks for. */

const landingModule = () => import('../../src/settings-landing.js').catch(() => null)

function landingPage({ rowHeight, visible = 900, controls = [] }) {
  const doc = { body: { id: 'body' }, documentElement: {}, activeElement: null }
  doc.activeElement = doc.body
  let rowTop = 1700
  const scrolls = []
  const control = ({ name, offset, disabled = false }) => ({
    name, disabled, getAttribute: () => null, closest: () => null,
    getClientRects: () => [{}],
    getBoundingClientRect: () => ({ top: rowTop + offset, bottom: rowTop + offset + 32, height: 32 }),
    focus(options) { doc.activeElement = this; this.focusOptions = options },
  })
  const row = {
    list: controls.map(control), attributes: new Map(),
    getClientRects: () => [{}],
    getBoundingClientRect: () => ({ top: rowTop, bottom: rowTop + rowHeight, height: rowHeight }),
    querySelectorAll() { return this.list },
    contains(node) { return node === this || this.list.includes(node) },
    hasAttribute(name) { return this.attributes.has(name) },
    setAttribute(name, value) { this.attributes.set(name, value) },
    focus(options) { doc.activeElement = this; this.focusOptions = options },
    scrollIntoView(options) {
      scrolls.push(options)
      rowTop = options.block === 'start' ? 0 : (visible - rowHeight) / 2
    },
  }
  const timers = []
  let clock = 0
  const run = {
    findRow: () => row, visibleBox: () => ({ top: 0, bottom: visible }), doc,
    wait: (fn, ms) => { timers.push({ fn, at: clock + ms }); return timers.length },
    stopWaiting: () => {}, now: () => clock,
  }
  const advance = ms => {
    const until = clock + ms
    for (;;) {
      const next = timers.filter(t => !t.done && t.at <= until).sort((a, b) => a.at - b.at)[0]
      if (!next) break
      clock = next.at; next.done = true; next.fn()
    }
    clock = until
  }
  return { doc, row, scrolls, run, advance, control }
}

test('a row taller than the page is shown from its start, and focus goes to a control on screen (T1411)', async () => {
  const mod = await landingModule()
  assert.ok(mod?.landOnRow, 'Settings still centres every landed row and focuses its first control wherever it is')
  const page = landingPage({ rowHeight: 2100, controls: [{ name: 'Install Codex', offset: 190 }, { name: 'Install Claude', offset: 900 }] })
  const stop = mod.landOnRow(page.run)
  assert.equal(typeof stop, 'function')
  assert.deepEqual(page.scrolls, [{ behavior: 'auto', block: 'start' }], 'a 2,100 px row is centred past its heading')
  assert.equal(page.doc.activeElement.name, 'Install Codex')
  const box = page.doc.activeElement.getBoundingClientRect()
  assert.ok(box.top >= 0 && box.bottom <= 900, `focus went to a control off screen (top ${box.top})`)
  assert.deepEqual(page.doc.activeElement.focusOptions, { preventScroll: true })
  /* A row that fits is still centred, as before. */
  const short = landingPage({ rowHeight: 120, controls: [{ name: 'switch', offset: 40 }] })
  mod.landOnRow(short.run)
  assert.deepEqual(short.scrolls, [{ behavior: 'auto', block: 'center' }])
  assert.equal(short.doc.activeElement.name, 'switch')
})

test('a control that is not on screen is never focused, even when it comes first', async () => {
  const mod = await landingModule()
  assert.ok(mod?.landingControl, 'no on-screen check: the first control is focused wherever it is')
  const page = landingPage({ rowHeight: 2100, controls: [{ name: 'above', offset: -400 }, { name: 'Get a code', offset: 300 }] })
  mod.landOnRow(page.run)
  assert.equal(page.doc.activeElement.name, 'Get a code')
})

test('a row whose controls arrive late still gets focus, and the person keeps any place they chose (T1594)', async () => {
  const mod = await landingModule()
  assert.ok(mod?.landOnRow, 'focus is tried once on the first frame and then given up')
  const page = landingPage({ rowHeight: 400, controls: [] })
  mod.landOnRow(page.run)
  assert.equal(page.doc.activeElement, page.doc.body, 'nothing usable yet, so nothing may be focused yet')
  page.advance(250)
  page.row.list.push(page.control({ name: 'Get a code', offset: 120 }))
  page.advance(150)
  assert.equal(page.doc.activeElement.name, 'Get a code', 'the control that arrived late was never focused')

  /* A disabled control is not usable; if nothing usable ever arrives the row
     itself takes focus, so a screen reader is at least taken to it. */
  const empty = landingPage({ rowHeight: 400, controls: [{ name: 'waiting', offset: 100, disabled: true }] })
  mod.landOnRow(empty.run)
  empty.advance(mod.LANDING_FOCUS_WAIT_MS + 200)
  assert.equal(empty.doc.activeElement, empty.row)
  assert.equal(empty.row.attributes.get('tabindex'), '-1')

  /* The person moved on (Tab to the search box) before the control arrived:
     the landing does not pull focus back. */
  const moved = landingPage({ rowHeight: 400, controls: [] })
  mod.landOnRow(moved.run)
  const search = { name: 'search' }
  moved.doc.activeElement = search
  moved.row.list.push(moved.control({ name: 'Get a code', offset: 120 }))
  moved.advance(mod.LANDING_FOCUS_WAIT_MS + 200)
  assert.equal(moved.doc.activeElement, search)

  /* Cancelled (the page was left), it stops trying. */
  const left = landingPage({ rowHeight: 400, controls: [] })
  const stop = mod.landOnRow(left.run)
  stop()
  left.row.list.push(left.control({ name: 'Get a code', offset: 120 }))
  left.advance(mod.LANDING_FOCUS_WAIT_MS + 200)
  assert.equal(left.doc.activeElement, left.doc.body)
})

test('the Settings view lands every named row through that one rule', async () => {
  const { readFileSync } = await import('node:fs')
  const view = readFileSync(new URL('../../src/views/settings.js', import.meta.url), 'utf8')
  assert.match(view, /import \{ landOnRow, visibleBoxOf \} from '\.\.\/settings-landing\.js'/)
  assert.match(view, /landOnRow\(\{/)
  assert.doesNotMatch(view, /scrollIntoView\(\{ behavior: 'auto', block: 'center' \}\)/, 'a second, centring landing is back in the view')
})
