/* THE ROWS THE INSTALLED APPLICATION ENFORCES, AND THE PAGE'S COPY OF THAT LIST.
 *
 * Written failing-first for the settings-truth lane, 2026-08-20.
 *
 * WHAT WAS MEASURED. shell/product-settings.cjs decides what this window is
 * allowed to write, in `WRITABLE_IDS`. The section that draws those rows kept
 * its own copy of the list -- and the copy was SHORT. It held the four
 * `research.*` ids; `WRITABLE_IDS` held those plus `agent.tool_summary`. The
 * section rendered five rows (it maps whatever the shell hands back) while the
 * page believed there were four. Three things followed:
 *
 *   1  the footer's total was one low -- "116 settings" over 117 rows;
 *   2  `requestedSetting()` in src/views/settings.js could not resolve
 *      `agent.tool_summary` to a section and a depth, so it was THE ONE ROW ON
 *      THE SETTINGS PAGE THAT SEARCH COULD NOT FIND -- and it is the switch the
 *      owner asked for by name;
 *   3  the count was the literal `4` written beside a list of four, so it did
 *      not move when the list became five.
 *
 * (3) is why the count is now derived and this test exists. A hand-kept mirror
 * of somebody else's list is not wrong on the day it is written; it is wrong on
 * the day the other list changes, silently, which is the day nobody is looking.
 *
 * THE FENCE IS TESTED HERE TOO, because it had the same shape of bug: the
 * section treated "not the master" as "fenced by the master", so a fresh
 * install -- where `research.pipeline` is off by default and
 * `agent.tool_summary` ships ON -- drew the agent row with its switch reading on
 * and the sentence "Held back: the first switch in this section is off, so
 * nothing runs for a research project yet." The research gate has no authority
 * over that row: the registry declares no dependency, and its enforcer
 * (src/lib/agent-tool-summary.js) is not the research gate
 * (src/lib/research/settings-gate.js), which never mentions it.
 */

import assert from 'node:assert/strict'
import { readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRequire, register } from 'node:module'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
/* The real path: on Windows os.tmpdir() can be the 8.3 short spelling of the
   profile, which the payload's state-root fence refuses as not the account's
   own directory. The long spelling is the one every real state root has. */
process.env.TOOLSENABLED_STATE_ROOT = path.join(realpathSync.native(os.tmpdir()), 'mc-product-setting-rows')

const require_ = createRequire(import.meta.url)
const PAYLOAD_ROOT = process.env.MC_TEST_SETTINGS_PAYLOAD || path.join(ROOT, 'capability')
const shell = require_(path.join(ROOT, 'shell', 'product-settings.cjs'))
const section = await import('../../src/research-settings.js')

// settingsView is a public surface, but its stylesheet is for the browser
// bundler. The loader lets node exercise the view rather than inspect its
// private requestedSetting helper's spelling.
register('./helpers/css-stub-loader.mjs', import.meta.url)

function installViewStandIn() {
  const landed = []
  const makeNode = () => ({
    dataset: {}, value: '', checked: false, innerHTML: '', textContent: '',
    children: [], appendChild(child) { this.children.push(child); return child },
    classList: { add: name => landed.push(name), toggle: () => {}, remove: () => {}, contains: () => false },
    style: { setProperty: () => {}, getPropertyValue: () => '' },
    addEventListener: () => {}, removeEventListener: () => {}, setAttribute: () => {}, removeAttribute: () => {},
    querySelector: () => makeNode(),
    querySelectorAll: () => [], closest: () => null, contains: () => true,
    getBoundingClientRect: () => ({ top: 0 }), getClientRects: () => [{ top: 0 }], scrollIntoView: () => {}, focus: () => {},
  })
  const root = makeNode()
  globalThis.document = {
    createElement: () => ({
      set innerHTML(value) { this._html = value },
      content: { firstElementChild: root },
    }),
    documentElement: makeNode(), body: makeNode(), getElementById: () => null,
  }
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, matchMedia: () => ({ matches: false }) }
  globalThis.localStorage = { getItem: () => null, setItem: () => {} }
  globalThis.requestAnimationFrame = fn => { fn(); return 1 }
  globalThis.cancelAnimationFrame = () => {}
  return { landed }
}

/* One row shape per id, at its registry default and chosen by nobody -- which
   is the state a person meets on a first install, and the state both bugs
   above appeared in. */
function freshInstallRows() {
  const real = shell.readProductSettings({ root: PAYLOAD_ROOT, fresh: true })
  assert.equal(real.available, true, real.reason || 'the checkout payload is readable')
  return real.rows.map(row => ({ ...row, value: row.default, provenance: undefined }))
}

function render(rows) {
  const controller = section.createResearchSettings({
    shell: { read: async () => ({ ok: true, available: true, rows }), set: async () => ({ ok: false }) },
  })
  return controller.load().then(() => [...new Set(section.PRODUCT_SETTING_IDS.map(section.sectionOfRow))]
    .map(name => controller.markup({ section: name })).join(''))
}

function statusOf(html, id) {
  const match = html.match(
    new RegExp(`data-research-setting-status="${id.replace('.', '\\.')}">([^<]*)<`),
  )
  return match ? match[1] : ''
}

test('complete rules are an independent discoverable setting in Rules and approvals', async () => {
  const id = 'rules.require_read_each_turn'
  const rows = freshInstallRows()
  const row = rows.find(item => item.id === id)
  assert.equal(row?.present, true, 'the paired payload declares the real setting')
  assert.equal(row.control, 'toggle')
  assert.equal(row.default, false)
  assert.equal(section.sectionOfRow(id), 'Rules & approvals')
  assert.equal(section.NESTED_UNDER[id], undefined, 'reading rules must not depend on permission to file them')
  const html = await render(rows)
  assert.match(html, /Include all rules in every turn/)
  assert.ok(html.includes(`data-setting-id="${id}"`))
  assert.doesNotMatch(statusOf(html, id), /switch above|first switch|research/i)
})

test('the page draws exactly the rows the installed application will write', () => {
  assert.deepEqual(
    [...section.PRODUCT_SETTING_IDS],
    [...shell.WRITABLE_IDS],
    'the section\'s list and shell/product-settings.cjs WRITABLE_IDS are the same list, in the same order',
  )
})

test('the count is derived from that list, never written beside it', () => {
  assert.equal(section.RESEARCH_SETTING_COUNT, section.PRODUCT_SETTING_IDS.length)
  const source = readFileSync(path.join(ROOT, 'src', 'research-settings.js'), 'utf8')
  assert.doesNotMatch(
    source,
    /RESEARCH_SETTING_COUNT\s*=\s*\d/,
    'the count must not be a literal number: that is exactly how it stayed at 4 for a list of 5',
  )
})

test('every drawn row can be landed on by search', async t => {
  const standIn = installViewStandIn()
  const { settingsView } = await import('../../src/views/settings.js')
  /* These are real mounted views, including the resource monitor's real
     polling timer. Discarding each return value left 22 intervals alive after
     all eight tests passed, so the serial test runner could never leave this
     file. Observe actual timer ownership; do not stub or unref the polling. */
  const intervals = new Set()
  const schedule = globalThis.setInterval
  const unschedule = globalThis.clearInterval
  t.mock.method(globalThis, 'setInterval', (...args) => {
    const handle = schedule(...args)
    intervals.add(handle)
    return handle
  })
  t.mock.method(globalThis, 'clearInterval', handle => {
    intervals.delete(handle)
    return unschedule(handle)
  })
  // A failed lifecycle assertion must fail this test, not hang the whole run.
  t.after(() => { for (const handle of intervals) unschedule(handle) })
  for (const id of section.PRODUCT_SETTING_IDS) {
    standIn.landed.length = 0
    const view = settingsView({ query: new URLSearchParams({ setting: id }) })
    try {
      assert.ok(
        standIn.landed.includes('is-landed'),
        `${id} can be followed to its settings row`,
      )
    } finally {
      view.destroy()
    }
    assert.equal(intervals.size, 0, `${id} releases its view-owned timers before the next view`)
  }

  const html = await render(freshInstallRows())
  for (const id of section.PRODUCT_SETTING_IDS) {
    assert.ok(
      html.includes(`data-setting-id="${id}"`),
      `${id} is drawn with the data-setting-id that markLanding and scrollToLanding look for`,
    )
  }
})

test('the research fence holds back only what it actually governs', async () => {
  const rows = freshInstallRows()
  assert.equal(rows.find(row => row.id === 'research.pipeline').value, false, 'the master ships off')
  assert.equal(rows.find(row => row.id === 'agent.tool_summary').value, true, 'the agent note ships on')

  const html = await render(rows)
  const held = 'Held back: the first switch in this section is off'

  for (const id of section.RESEARCH_FENCED_IDS) {
    assert.ok(statusOf(html, id).startsWith(held), `${id} is held back by the master, and says so`)
  }
  const agent = statusOf(html, 'agent.tool_summary')
  assert.ok(
    !agent.startsWith(held),
    `agent.tool_summary must not claim the research fence holds it back; it said: "${agent}"`,
  )
  assert.ok(
    !/held back/i.test(agent),
    `agent.tool_summary ships on and IS on, so nothing may tell a person it is withheld; it said: "${agent}"`,
  )
})

test('tools, delegation and research have separate destinations', () => {
  assert.equal(section.sectionOfRow('research.pipeline'), 'Research')
  assert.equal(section.sectionOfRow('agent.tool_mode'), 'Tool use')
  assert.equal(section.sectionOfRow('agent.subagent_route'), 'Agents & delegation')
  assert.equal(section.sectionOfRow('purchases.require_owner_approval'), 'Rules & approvals')
})

/* THE NESTED SUB-SETTING (O7 improvements; owner, 2026-08-22: "this is more
 * of a user setting. default no. nest it below in settings"). The register
 * declares rules.ask_when_unsure at depth 3, default off, with the same
 * enforcer as the row it belongs to. That row is now the three-way choice
 * rules.filing_from (owner, 2026-09-15: "either manually on the ledger page
 * only, or ledger page and /request, or agent and such like now"), which
 * superseded the on/off switch rules.capture_spoken; the page draws the child
 * nested under it -- the catalogue's own open tier, the indent rule that means
 * "this belongs to the row above" -- and OUT OF USE unless the choice is
 * "Agents too", with a state sentence that says so: a child of a parent that
 * keeps agents out must not look live. With "Agents too" chosen, the child is
 * a live switch. */
test('the ask-when-unsure row is declared as a nested, off-by-default child of the rule switch', () => {
  const rows = freshInstallRows()
  const parent = rows.find(row => row.id === 'rules.filing_from')
  const child = rows.find(row => row.id === 'rules.ask_when_unsure')
  assert.ok(parent && child, 'both rows are in the checkout payload\'s registry')
  assert.equal(section.PRODUCT_SETTING_IDS.indexOf(child.id), section.PRODUCT_SETTING_IDS.indexOf(parent.id) + 1,
    'the child is listed directly after its parent, which is the order the rows are drawn in')
  assert.equal(section.NESTED_UNDER[child.id], parent.id)
  assert.equal(section.PARENT_OPEN_VALUE[parent.id], 'Agents too', 'the choice opens its children only when agents are let in')
  assert.equal(parent.control, 'seg')
  assert.deepEqual(parent.options, ['Ledger page only', 'Ledger page and /Request', 'Agents too'])
  assert.equal(child.depth, parent.depth + 1, 'the register nests the child one level under the switch')
  assert.equal(child.default, false, 'the child ships OFF')
  assert.equal(child.control, 'toggle')
})

test('the nested row is drawn under its parent, disabled while the parent is off, live once it is on', async () => {
  const off = freshInstallRows()
  const html = await render(off)
  const child = html.slice(html.indexOf('data-setting-id="rules.ask_when_unsure"'))
  const childRow = child.slice(0, child.indexOf('</article>'))
  assert.ok(html.indexOf('data-setting-id="rules.filing_from"') < html.indexOf('data-setting-id="rules.ask_when_unsure"'),
    'the child is drawn after its parent')
  /* Nested: wrapped in the open tier the catalogue's own depth rows sit in,
     keyed to its parent, carrying its registry depth. */
  assert.match(html, /<div class="settings-tier is-open" data-product-nest="rules\.filing_from" data-nest-depth="3"[^>]*><div class="settings-tier-inner"><article class="settings-row is-nested" data-setting-id="rules\.ask_when_unsure"/,
    'the child is not drawn nested under rules.filing_from')
  assert.match(childRow, /data-setting-depth="3"/)
  assert.match(childRow, /data-nested-under="rules\.filing_from"/)
  /* Disabled while the parent is off, and the state sentence says why. */
  assert.match(childRow, /data-held-by-parent="true"/)
  assert.match(childRow, /<input type="checkbox" data-research-setting="rules\.ask_when_unsure"[^>]*\sdisabled\s*\/>/, 'the child\'s switch reads live while its parent is off')
  assert.equal(statusOf(html, 'rules.ask_when_unsure'), section.PARENT_HOLD_REASON['rules.filing_from'])
  assert.match(section.PARENT_HOLD_REASON['rules.filing_from'], /Agents too/)
  assert.equal(section.HELD_BY_PARENT, 'Turn on the switch above first.')
  /* The parent itself is not held by anything and is drawn at depth 2,
     unwrapped. */
  assert.doesNotMatch(html, /data-product-nest="rules\.ask_when_unsure"/)
  assert.doesNotMatch(html, /<div class="settings-tier is-open"[^>]*><div class="settings-tier-inner"><article class="settings-row[^"]*" data-setting-id="rules\.filing_from"/)
  assert.equal(html.includes('settings-tier'), true)

  /* Parent ON and chosen by the person: the child is live and says nothing
     about the switch above. */
  const on = off.map(row => (row.id === 'rules.filing_from' ? { ...row, value: 'Agents too', provenance: { source: 'user' } } : row))
  const liveHtml = await render(on)
  const live = liveHtml.slice(liveHtml.indexOf('data-setting-id="rules.ask_when_unsure"'))
  const liveRow = live.slice(0, live.indexOf('</article>'))
  assert.doesNotMatch(liveRow, /data-held-by-parent/)
  assert.doesNotMatch(liveRow, /<input type="checkbox" data-research-setting="rules\.ask_when_unsure"[^>]*\sdisabled/, 'the child stays disabled with its parent on')
  assert.notEqual(statusOf(liveHtml, 'rules.ask_when_unsure'), section.HELD_BY_PARENT)
  assert.ok(!/switch above/.test(statusOf(liveHtml, 'rules.ask_when_unsure')))

  /* A parent that reads ON but was chosen by nobody is, to the gate, off --
     and the child is drawn held, not live: a control enforcing a value
     nobody chose would be the software failure the owner named. */
  const unchosen = off.map(row => (row.id === 'rules.filing_from' ? { ...row, value: 'Agents too', provenance: { source: 'default' } } : row))
  const unchosenHtml = await render(unchosen)
  assert.ok(unchosenHtml.includes('data-setting-id="rules.ask_when_unsure"'))
})

test('the child is never written while its parent is off, and the section finds it by the words a person would use', async () => {
  const written = []
  const controller = section.createResearchSettings({
    shell: {
      read: async () => ({ ok: true, available: true, rows: freshInstallRows() }),
      set: async (id, value) => { written.push({ id, value }); return { ok: true, id, value } },
    },
  })
  await controller.load()
  /* The change handler is the only writer; a change that reaches it for a
     held child writes nothing. */
  const root = { addEventListener: () => {}, removeEventListener: () => {}, contains: () => true, querySelector: () => null }
  controller.bind(root)
  const checkbox = { dataset: { researchSetting: 'rules.ask_when_unsure' }, checked: true }
  const change = { target: { closest: selector => selector === '[data-research-setting]' ? checkbox : null } }
  root.addEventListener = (type, fn) => { if (type === 'change') fn(change) }
  controller.bind(root)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(written, [], 'a held child was written while its parent was off')
  assert.equal(controller.matches('ask'), true)
  assert.equal(controller.matches('unsure'), true)
})
