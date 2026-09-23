/* THE SETTINGS PAGE'S TWO-LEVEL SHAPE, AND THE SENTENCES ON ITS ROWS.
 *
 * Written failing-first for the settings-ia lane. Three families:
 *
 *   1  THE GROUPS. The seventeen flat categories nest under a handful of
 *      top-level groups a person can scan in one glance. The registry and the
 *      section names do not change -- grouping is presentation -- so the model
 *      is a pure mapping, and the one thing that must never happen is a section
 *      falling out of every group (it would silently vanish from the page) or
 *      into two (it would render twice). The section list asserted here is
 *      cross-checked against src/views/settings.js by the source test below.
 *
 *   2  THE STATE SENTENCES. Measured tonight on the driven build: a Write row
 *      whose switch read ON carried the sentence "This ships switched off",
 *      and the reader believed the sentence over the switch. The rule under
 *      test: the sentence says the CURRENT truth first, and never contradicts
 *      the visible control.
 *
 *   3  THE SYSTEM REFUSALS. "machines[0].ip address is required" is a machine
 *      word on the glass. The translation keeps the precise field named while
 *      leading with a human sentence.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  FIRST_VISIT_SECTION,
  SETTINGS_GROUPS,
  categorySlug,
  groupOfSection,
  sectionFromSlug,
  groupsOpenOnArrival,
  readOpenGroups,
  writeOpenGroups,
  toggleStateSentence,
  humanizeProfileError,
  humanizeProfileErrors,
} from '../../src/settings-presentation.js'
import { CHATBOX_SECTION } from '../../src/chatbox-settings.js'
import { RESEARCH_SECTION } from '../../src/research-settings.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/* The twelve sections the page renders today, in its own order. If the page
   gains or loses one, this list and the groups must move together -- the source
   assertions below are what notice the drift.

   'Connect this computer' JOINED THIS LIST ON 2026-08-22, and its absence until
   then was the finding rather than an oversight. The section was rendered by
   src/views/settings.js and placed by a hand-written branch in that same file,
   because groupOfSection() answered null for it -- so it was genuinely not part
   of the grouping model this suite describes, and listing it here would have
   failed "every section lives in exactly one group" truthfully. The branch is
   gone and the name is in the 'start' group, so it belongs here now. The cost
   of the shim was not a mis-drawn section: the group head prints
   `group.sections` while CLOSED, so the one line whose job is "find it without
   opening anything" never said the words "connect this computer".

   IT WAS SEVENTEEN UNTIL 2026-08-20. Six went in one edit -- Fleet Graph,
   Metrics, Chat & Threads, Comms Board, Performance and Developer -- because
   every row in them wrote a `mc.set.<id>` key that nothing in the product read,
   and removing their rows would otherwise have left six titled headings with
   nothing under them. This list is edited here deliberately, not to make a red
   go green: the source assertions further down cross-check it against
   src/views/settings.js, so a list that disagreed with the page would fail
   either way. The removed rows are kept verbatim in
   docs/design/UNBUILT-SETTINGS-ROWS-2026-08-20.md.

   'Research' became 'Research & Agents' in the same edit: it draws every
   setting the installed application enforces, which stopped being only the
   research family when `agent.tool_summary` joined it. */
/* 'Notifications' JOINED ON 2026-08-27 with the two rows that decide whether
   this computer tells you an agent finished or stopped. It is in the 'actions'
   group beside 'Research & Agents', not a group of its own: a group holding one
   section that repeats its own name is the shape the 'Your data' comment in
   src/settings-presentation.js records as a defect. */
/* 'This computer' JOINED ON 2026-09-10, with the page it replaced. src/views/guide.js
   was "What this copy needs": a document at its own address, off the ring, that
   a person reached only by following a refusal. Its live half -- what is
   installed here, the Install and Sign in buttons, the account lists, the
   local-model panel and the feedback composer -- is a section of this page now,
   first in the 'start' group, and the page is one section shorter of prose for
   it. The owner's words: "can we get rid of the what this copy needs page and
   put it nicely into settings and make it more simple and useful". */
const SECTIONS = [
  'This computer',
  'Connect this computer', 'Home screen', 'System', 'Setup', 'Data & Privacy',
  'Research', 'Tool use', 'Agents & delegation', 'Resources', 'Local models',
  'Appearance', 'Text & Reading', 'Motion & Effects', 'Accessibility',
  'Rules & approvals', 'What the screens show', 'App permissions', 'Notifications', 'Business controls',
]

test('every section lives in exactly one group', () => {
  const seen = new Map()
  for (const group of SETTINGS_GROUPS) {
    for (const section of group.sections) {
      assert.equal(seen.has(section), false, `${section} is in ${seen.get(section)} and ${group.id}`)
      seen.set(section, group.id)
    }
  }
  for (const section of SECTIONS) {
    assert.ok(seen.has(section), `${section} is in no group and would vanish from the page`)
  }
  assert.equal(seen.size, SECTIONS.length, 'a group names a section the page does not render')
})

test('the groups are few enough to scan, and each names itself in plain words', () => {
  assert.ok(SETTINGS_GROUPS.length >= 4 && SETTINGS_GROUPS.length <= 7,
    `${SETTINGS_GROUPS.length} top-level groups is not a glanceable set`)
  for (const group of SETTINGS_GROUPS) {
    assert.ok(group.id && /^[a-z][a-z-]*$/.test(group.id), `group id ${group.id}`)
    assert.ok(group.label && group.label.length <= 28, `label "${group.label}" is not glanceable`)
  }
})

test('groupOfSection answers for every section and refuses the unknown', () => {
  for (const section of SECTIONS) {
    const group = groupOfSection(section)
    assert.ok(group, `${section} has no group`)
    assert.ok(group.sections.includes(section))
  }
  assert.equal(groupOfSection('No Such Section'), null)
})

/* ---------- the address of a category ----------
   Each category is its own page and its own address. The slug is derived from
   the section name rather than filed beside it, so what has to be tested is
   that the derivation is reversible and that no two names land on one slug --
   a collision would silently make one category unreachable. */

test('every category has an address, and no two share one', () => {
  const slugs = SECTIONS.map(categorySlug)
  for (const [index, slug] of slugs.entries()) {
    assert.match(slug, /^[a-z0-9]+(-[a-z0-9]+)*$/, `"${SECTIONS[index]}" derived "${slug}"`)
  }
  assert.equal(new Set(slugs).size, SECTIONS.length, `two categories share an address: ${slugs}`)
})

test('an address reads back as the section it was made from', () => {
  for (const section of SECTIONS) {
    assert.equal(sectionFromSlug(categorySlug(section)), section)
  }
  /* Typed, pasted or capitalised by a link: the same category. */
  assert.equal(sectionFromSlug(' Data-Privacy '), 'Data & Privacy')
})

test('bookmarks to renamed categories still reach the corresponding controls', () => {
  assert.equal(sectionFromSlug('research-agents'), 'Research')
  assert.equal(sectionFromSlug('things-it-may-do-for-you'), 'App permissions')
  assert.equal(sectionFromSlug('ledger'), 'Rules & approvals')
})

test('an address no section answers to is null, not a guess', () => {
  for (const slug of ['', '   ', 'developer', 'fleet-graph', null, undefined, 7, {}]) {
    assert.equal(sectionFromSlug(slug), null, `sectionFromSlug(${JSON.stringify(slug)})`)
  }
})

/* ---------- remembered open-state ---------- */

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: key => { map.delete(key) },
  }
}

test('groups are collapsed by default: an empty store opens nothing', () => {
  const open = readOpenGroups(memoryStorage())
  assert.equal(open.size, 0)
})

test('open-state round-trips, and unknown ids are dropped rather than kept', () => {
  const storage = memoryStorage()
  const first = SETTINGS_GROUPS[0].id
  const second = SETTINGS_GROUPS[1].id
  writeOpenGroups([first, second, 'no-such-group'], storage)
  const open = readOpenGroups(storage)
  assert.ok(open.has(first) && open.has(second))
  assert.equal(open.has('no-such-group'), false)
})

test('a corrupt store reads as the default, never as a throw', () => {
  const storage = memoryStorage()
  writeOpenGroups([SETTINGS_GROUPS[0].id], storage)
  storage.setItem('mc.settings.open-groups', '{not json')
  assert.equal(readOpenGroups(storage).size, 0)
  assert.equal(readOpenGroups(null).size, 0)
})

/* ---------- arriving, as opposed to returning ----------
 *
 * WHAT WAS MEASURED, on the 1.0.20 cut, driving the packaged build on a sterile
 * profile (tools/signin-reach-probe.mjs). A person who has just installed this
 * opens Settings and gets SIX GREY HEADINGS AND NOTHING ELSE. Six of the page's
 * 246 controls had a box; the product's own footer said it out loud --
 *
 *     "116 settings · 0 shown · search finds the hidden ones too"
 *
 * QUOTED AS MEASURED, AND DELIBERATELY LEFT AT 116. This is what the footer said
 * on the 1.0.20 cut and it is the evidence for the defect above; editing the
 * number to match today's build would be falsifying a measurement. For the
 * record: 74 rows that wrote a key nothing read were removed on 2026-08-20 and
 * the same footer now reads 43. Nothing in this suite asserts either number --
 * the footer's total is computed in src/views/settings.js from the catalogue
 * lengths, so it follows the catalogue and cannot be pinned here without
 * pinning it in two places.
 *
 * -- and the ancestor walk named the mechanism exactly:
 * DIV.settings-group-body#settings-group-start, hidden=true, display=none,
 * box 0x0, with `a.ctl-btn[href="#/account"]` inside it computing display:flex
 * and measuring 0x0. `#/account` has exactly ONE persistent door in this
 * product (src/fleet-profile-settings.js), and it was behind that collapse. So
 * the single most important thing a person with no account can do was not on
 * the screen, and pressing the group header put it there -- proving the
 * collapse was the whole cause rather than occlusion or a broken anchor.
 *
 * THE RULE, AND WHY IT IS NARROW. Remembered posture is not touched:
 * readOpenGroups still opens nothing from an empty store, because "what this
 * person last left open" is a different question from "what should be open for
 * somebody who has never been here". The arrival rule adds one clause to the
 * one that already existed for links, and it applies ONLY when there is no
 * posture to honour -- the first press this person makes on any group is the
 * last time this rule ever runs for them. It opens the group holding the
 * outstanding action rather than a hardcoded index, so if System is ever
 * regrouped the rule follows it instead of quietly opening the wrong thing.
 */

test('a first arrival opens the group holding sign-in, not an empty page', () => {
  /* THE SECTION THIS OPENS FOR IS NOW 'This computer', and the rule is stronger
     for it than it was for 'Tool use'. That section holds the Install and Sign
     in buttons for Codex, Claude and Gemini, so a first visit that left every
     group shut would hide the only controls that make an agent startable at
     all -- as well as the door to #/account this rule was measured for, which
     is in the same group. Asserted through FIRST_VISIT_SECTION rather than by
     naming the group, so a regroup follows the section instead of going red. */
  const open = groupsOpenOnArrival(memoryStorage())
  const arrivalGroup = groupOfSection(FIRST_VISIT_SECTION)
  assert.ok(arrivalGroup, `${FIRST_VISIT_SECTION} is in no group`)
  assert.ok(open.has(arrivalGroup.id),
    `a first visit left every group shut, so the only door to #/account is 0x0`)
  const connectGroup = groupOfSection('Connect this computer')
  assert.equal(arrivalGroup.id, connectGroup?.id,
    'the first-visit section moved out of the group holding the connect screen, so the measured 0x0 door is shut again')
})

test('the first-visit section is the one holding the install and sign-in controls', () => {
  /* Not a spelling pin on the name: the assertion is that the section the
     arrival rule opens is the FIRST one in its group, which is the position
     this product gives to the thing somebody with nothing set up needs first.
     A rename follows; a demotion fails. */
  const group = groupOfSection(FIRST_VISIT_SECTION)
  assert.ok(group, `${FIRST_VISIT_SECTION} is in no group`)
  assert.equal(group.sections[0], FIRST_VISIT_SECTION,
    `${FIRST_VISIT_SECTION} opens on arrival but is not the first section of ${group.id}, so a person lands below something else`)
})

test('the arrival rule opens ONE group, so nesting still buys what it costs', () => {
  const open = groupsOpenOnArrival(memoryStorage())
  assert.equal(open.size, 1, `${open.size} groups open on arrival is not a page a person scans`)
})

test('a remembered posture wins over the arrival rule, in both directions', () => {
  /* Somebody who opened Appearance and shut everything else gets exactly that
     back. The arrival rule must not re-open Start here over their decision. */
  const storage = memoryStorage()
  const appearance = SETTINGS_GROUPS.find(group => group.id === 'appearance')
  writeOpenGroups([appearance.id], storage)
  const open = groupsOpenOnArrival(storage)
  assert.deepEqual([...open], [appearance.id],
    'a remembered posture was overwritten by the first-arrival default')
})

test('a link that names a row still opens that row group, arrival rule or not', () => {
  /* The named section used to be 'Developer', which no longer exists. It has to
     be one that is NOT the first-visit group, or the assertion passes on the
     arrival rule alone and stops testing the landing clause at all. 'What the screens show'
     is in `privacy` as of 2026-08-22 (it was in `screens`, which is gone); the
     arrival default is the group holding the first-visit section. The assertion
     below pins that difference rather than assuming it, so a future regroup
     that put the two together fails here instead of passing vacuously. */
  const landing = 'What the screens show'
  const group = groupOfSection(landing)
  assert.ok(group, `${landing} is in a group`)
  assert.equal(
    groupsOpenOnArrival(memoryStorage()).has(group.id),
    false,
    `${landing}'s group opens on arrival anyway, so this test proves nothing -- pick another section`,
  )
  const open = groupsOpenOnArrival(memoryStorage(), landing)
  assert.ok(open.has(group.id), 'following a link no longer opens the row it named')
})

test('the remembered-posture store is not written by merely arriving', () => {
  /* Arriving is not a filing decision -- the same rule the landing clause has
     always kept. If this ever writes, a person who never touched a group would
     have "start" filed as their posture and the rule would stop being able to
     tell a first visit from a returning one. */
  const map = new Map()
  const writes = []
  const storage = {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (...args) => { writes.push(['set', ...args]) },
    removeItem: (...args) => { writes.push(['remove', ...args]) },
  }
  groupsOpenOnArrival(storage)
  assert.deepEqual(writes, [], 'merely arriving wrote to the remembered-posture store')
})

/* ---------- state sentences: the truth first, never a contradiction ---------- */

test('a toggle that is on never carries a sentence that reads as off', () => {
  for (const def of [true, false]) {
    for (const acts of [true, false]) {
      const on = toggleStateSentence({ value: true, def, acts })
      const off = toggleStateSentence({ value: false, def, acts })
      assert.ok(on.startsWith('On.'), `on sentence leads with the truth: "${on}"`)
      assert.ok(off.startsWith('Off.'), `off sentence leads with the truth: "${off}"`)
      /* The exact defect: "This ships switched off" as the FIRST claim beside a
         switch reading ON. The shipped default may be mentioned, only after. */
      assert.notEqual(on.indexOf('On.'), -1)
      assert.ok(!/^This ships/.test(on) && !/^This ships/.test(off))
    }
  }
})

test('the acting family states the shipped default and what is true right now', () => {
  const on = toggleStateSentence({ value: true, def: false, acts: true })
  const off = toggleStateSentence({ value: false, def: false, acts: true })
  assert.ok(/ships switched off/i.test(on), `the on sentence still names the shipped default: "${on}"`)
  assert.ok(/ships switched off/i.test(off))
  assert.ok(/turned on/i.test(on), `the on sentence says how it came to be on: "${on}"`)
  assert.ok(/the computer you are driving/i.test(on), `the on sentence names the driven machine: "${on}"`)
  assert.ok(!/this computer/i.test(on), `the on sentence does not misname the browser as the machine: "${on}"`)
  assert.ok(/nothing acts/i.test(off), `the off sentence keeps the guarantee: "${off}"`)
})

test('a quiet toggle at its shipped value says only the truth', () => {
  const shippedOn = toggleStateSentence({ value: true, def: true })
  const shippedOff = toggleStateSentence({ value: false, def: false })
  const changedOn = toggleStateSentence({ value: true, def: false })
  const changedOff = toggleStateSentence({ value: false, def: true })

  assert.ok(shippedOn.startsWith('On.'), `an on toggle leads with its current truth: "${shippedOn}"`)
  assert.ok(shippedOff.startsWith('Off.'), `an off toggle leads with its current truth: "${shippedOff}"`)
  assert.doesNotMatch(shippedOn, /ships/i,
    `a toggle at its shipped value invents a change from that default: "${shippedOn}"`)
  assert.doesNotMatch(shippedOff, /ships/i,
    `a toggle at its shipped value invents a change from that default: "${shippedOff}"`)
  assert.ok(changedOn.startsWith('On.') && /ships? (?:switched )?off/i.test(changedOn),
    `an on toggle changed from its off default does not state both truths: "${changedOn}"`)
  assert.ok(changedOff.startsWith('Off.') && /ships? (?:switched )?on/i.test(changedOff),
    `an off toggle changed from its on default does not state both truths: "${changedOff}"`)
})

/* ---------- the System refusals, translated ---------- */

test('the machines[0].ip family becomes a sentence and keeps the field named', () => {
  const said = humanizeProfileError({ path: 'machines[0].ip', message: 'address is required' })
  assert.ok(/Machine 1/.test(said), `names the machine a person counts: "${said}"`)
  assert.ok(/address/.test(said))
  assert.ok(said.includes('machines[0].ip'), `keeps the precise field: "${said}"`)
  assert.ok(!/^machines\[/.test(said), 'does not lead with the machine words')
})

test('each address refusal keeps its own reason: missing, invalid, or carrying a login', () => {
  // T1586: every machine and connection address refusal read as 'needs an address'
  // or 'must be written as text', whatever the validator said.
  const machine = message => humanizeProfileError({ path: 'machines[0].ip', message })
  const lane = message => humanizeProfileError({ path: 'transports[1].endpoint', message })
  const missing = machine('address is required')
  const invalid = machine('is not a valid host, IP address, or URL')
  const login = machine('must not contain credentials')
  assert.match(missing, /Machine 1 needs an address/)
  assert.match(invalid, /Machine 1's address is not a valid host, IP address or URL/)
  assert.match(login, /Machine 1's address must not contain a user name or password/)
  assert.equal(new Set([missing, invalid, login]).size, 3, 'three reasons read as one')
  const laneInvalid = lane('is not a valid URL or host:port')
  const laneLogin = lane('must not contain credentials')
  const laneText = lane('must be text when present')
  assert.match(laneInvalid, /Connection 2's address is not a valid URL or host:port/)
  assert.match(laneLogin, /Connection 2's address must not contain a user name or password/)
  assert.match(laneText, /must be written as text/)
  assert.doesNotMatch(laneLogin, /written as text/, 'the credentials case lost its security reason')
  assert.equal(new Set([laneInvalid, laneLogin, laneText]).size, 3, 'three reasons read as one')
})

test('an empty roster or lane list reads as what to add, not as a field path', () => {
  // T1427
  const machines = humanizeProfileError({ path: 'machines', message: 'must contain at least one machine' })
  const lanes = humanizeProfileError({ path: 'transports', message: 'must declare at least one transport lane' })
  assert.match(machines, /^Add a machine to the Machine roster first\./)
  assert.match(lanes, /^Add a connection lane first\./)
  assert.doesNotMatch(`${machines} ${lanes}`, /must contain|must declare/)
})

test('the machine name and profile label refusals read as sentences', () => {
  const name = humanizeProfileError({ path: 'machines[1].name', message: 'is required' })
  assert.ok(/Machine 2/.test(name) && /name/.test(name), name)
  const label = humanizeProfileError({ path: 'label', message: 'is required' })
  assert.ok(/profile/i.test(label) && /name/.test(label), label)
})

test('a transport port refusal names the lane and the allowed range', () => {
  const said = humanizeProfileError({ path: 'transports[0].port', message: 'must be null or an integer from 1 through 65535' })
  assert.ok(/1 through 65535/.test(said), said)
  assert.ok(said.includes('transports[0].port'), said)
})

test('an unrecognized refusal still comes out whole, never dropped', () => {
  const said = humanizeProfileError({ path: 'spend.total', message: 'must be a finite number' })
  assert.ok(said.includes('spend.total') && said.includes('must be a finite number'), said)
  assert.equal(humanizeProfileErrors([]), '')
  const joined = humanizeProfileErrors([
    { path: 'machines[0].ip', message: 'address is required' },
    { path: 'label', message: 'is required' },
  ])
  assert.ok(/Machine 1/.test(joined) && /profile/i.test(joined), joined)
})

/* ---------- the page really uses all of it (source assertions, because the
   view imports stylesheets and cannot be loaded under node) ---------- */

test('the settings page renders from the group model, not from a flat list', () => {
  const source = readFileSync(path.join(ROOT, 'src', 'views', 'settings.js'), 'utf8')
  assert.ok(source.includes("from '../settings-presentation.js'"),
    'settings.js imports the shared group model')
  assert.ok(source.includes('SETTINGS_GROUPS'), 'settings.js renders the groups')
  /* The view reads the remembered posture through groupsOpenOnArrival, which is
     the only reader that also knows what to do when there is no posture yet.
     Pinned by INTENT rather than by the old symbol name: what must never
     regress is that the page reads a remembered state and writes it back, not
     which function it spells that with. */
  assert.ok(source.includes('groupsOpenOnArrival') && source.includes('writeOpenGroups'),
    'the open state is remembered, not reset every visit')
  assert.ok(source.includes('toggleStateSentence'), 'rows carry the truth-first state sentence')
})

test('the System section translates refusals before they reach the glass', () => {
  const source = readFileSync(path.join(ROOT, 'src', 'fleet-profile-settings.js'), 'utf8')
  assert.ok(source.includes('humanizeProfileErrors'),
    'fleet-profile-settings.js speaks the translated refusal')
})

test('the group labels match what the page sections actually are', () => {
  assert.ok(groupOfSection(CHATBOX_SECTION), `chatbox section "${CHATBOX_SECTION}" is grouped`)
  assert.ok(groupOfSection(RESEARCH_SECTION), `research section "${RESEARCH_SECTION}" is grouped`)
})
