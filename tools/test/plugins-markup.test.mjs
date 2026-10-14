/* THE SENTENCES ON THE PLUGIN CONSENT SCREEN, AND THE THREE WAYS THEY FAIL.
 *
 * This page asks a person to allow code a stranger wrote to do specific things on
 * their computer. The sentences ARE the product here, so they get a suite rather
 * than a read-through, and it covers the failures that are quiet:
 *
 *   1. A CAPABILITY STOPS BEING SHOWN. Either because the copy table has no entry
 *      for it, or because the page only draws the ones already allowed. Both end
 *      with a person consenting to something they were never shown, and neither
 *      looks like a bug from the outside.
 *   2. A DECLINED CAPABILITY DISAPPEARS. src/views/tools.js exists because withheld
 *      tools used to be COUNTED rather than listed. The same regression here means
 *      the only way to find out what a plugin wanted is to read its manifest.
 *   3. SOMETHING A PLUGIN WROTE IS DRAWN AS MARKUP. Every name, summary and tool
 *      description comes out of a file nobody here reviewed.
 *
 * Mutations run, one at a time, each landed in src/plugins-markup.js and confirmed
 * present before the run. Baseline and restored: green, 14 of 14.
 *   a. esc() reduced to `String(value ?? '')` -> red, 3 of 14 (the tool row's
 *      quoted claim, 'nothing a plugin wrote is drawn as markup', and the refused
 *      directory's escaped name).
 *   b. packageMarkup() drew `entry.granted` instead of `entry.requested` -> red,
 *      2 of 14 ('every capability the package asked for gets a row, including
 *      declined ones', and the read-only page).
 *   c. capabilityRowMarkup()'s unknown-capability fallback replaced with
 *      `if (!copy) return ''` -> red, 1 of 14.
 *   d. contributionLine() dropped its `inForce.includes(...)` checks -> red, 1 of
 *      14: it counted three roles a plugin had not been allowed to install.
 *
 * Six more, added with the skin, the plugin's own settings and its claimed limits.
 * Baseline and restored: green, 21 of 21.
 *   e. skinStyle() stopped applying its value patterns -> red, 1 of 21: a colour of
 *      `red;position:fixed;top:0;left:0;width:100vw` reached a style attribute.
 *   f. skinStyle() iterated the plugin's own keys instead of the fixed property
 *      vocabulary -> red, 9 of 21 (it throws on a null skin, so most of the file
 *      goes with it -- which is itself the point: the vocabulary is not optional).
 *   g. badgeWord() stopped checking the badge's shape -> red, 1 of 21.
 *   h. settingRowMarkup() dropped the risk list -> red, 1 of 21. The host refuses a
 *      row that omits its risks, and a screen that dropped the line would make that
 *      requirement pointless.
 *   i. limitsMarkup() dropped the sentence saying the limits are the package's own
 *      words and not enforcement -> red, 1 of 21.
 *   j. settingRowMarkup() shadowed esc() with an identity function -> red, 1 of 21.
 *
 * Three more from the real-app plugins walk (1.0.49, 2026-09-27), red 3 of 25
 * before the fix and green after. Mutations, one at a time, restored after:
 *   k. withdrawnOn() returned the stored timestamp -> red, 1 of 25.
 *   l. settingRowMarkup() dropped the "What could go wrong" label -> red, 1 of 25.
 *   m. contributionLine() ignored the roles a person's own roles hide -> red, 1 of 25.
 *
 * Run: node --test tools/test/plugins-markup.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { readFileSync } from 'node:fs'
import {
  runningMarkup, contrastRatio, badgeWord, capabilityRowMarkup, contributionLine, contributionRefusedMarkup, emptyMarkup,
  limitsMarkup, packageMarkup, pageMarkup, refusedMarkup, settingRowMarkup, shortId,
  skinStyle, stateSentence, toolRowMarkup, unavailableMarkup,
} from '../../src/plugins-markup.js'
import { CAPABILITY_COPY, effectRaisedSentence, withheldSentence } from '../../src/plugin-copy.js'

const VOCABULARY = ['storage', 'secrets', 'subprocess', 'network', 'auditLog', 'roles', 'settings', 'skin']

function entry(overrides = {}) {
  return {
    id: 'plugin-febdd76b95423581',
    sha256: 'febdd76b95423581f2c6bc062a66f6b11e66827b05af3dd7adfaf5eee47843c5',
    name: 'notes',
    displayName: 'Notes',
    summary: 'Keeps a searchable index of your own notes.',
    requested: ['storage', 'subprocess', 'roles', 'settings', 'skin'],
    granted: ['subprocess', 'roles'],
    inForce: ['subprocess', 'roles'],
    withheld: ['storage', 'settings', 'skin'],
    effectFloor: 'local-write',
    tools: [{
      name: 'plugin.notes.reindex',
      summary: 'Rebuild the index for a folder of notes.',
      declaredEffect: 'local-read',
      effect: 'local-write',
      approvalRequested: true,
      approvalWaived: false,
    }],
    roleCount: 3,
    declaresSettings: true,
    declaresRestrictions: true,
    hasSkin: true,
    settings: [{
      id: 'plugin.notes.reindex_on_open',
      key: 'reindex_on_open',
      label: 'Rebuild the index when a folder is opened',
      control: 'toggle',
      default: true,
      consequence: 'On, opening a folder rebuilds its index before anything reads it.',
      capabilities: ['Off, a folder opens straight away.'],
      risks: ['Off, a search can miss a note that was added since the last rebuild.'],
    }],
    limits: {
      note: 'Deny by default.',
      hardBlocks: [{ rule: 'No note is deleted without asking', why: 'Filing is a human decision.' }],
      requiresHumanApproval: ['Any deletion of a note'],
    },
    skin: { '--plugin-accent': '#0b6', '--plugin-radius': '5px', '--plugin-badge': 'Notes' },
    contributionsRefused: [],
    grantedAt: '2026-09-26T12:00:00Z',
    grantedBy: 'the person using this computer',
    revoked: null,
    ...overrides,
  }
}

test('every capability in the vocabulary has copy, and it says both things', () => {
  // A capability the build cannot describe is a capability a person is asked to
  // allow with no information. The vocabulary is the engine's; this asserts the
  // app has kept up with it.
  for (const capability of VOCABULARY) {
    const copy = CAPABILITY_COPY[capability]
    assert.ok(copy, `no copy for ${capability}`)
    assert.ok(copy.title && copy.title.length < 60, `${capability} title`)
    assert.ok(copy.grants && copy.grants.length > 30, `${capability} must say what it grants`)
    assert.ok(copy.risk && copy.risk.length > 30, `${capability} must say what it risks, separately`)
    assert.notEqual(copy.grants, copy.risk, `${capability}: one blended sentence is what this rule forbids`)
  }
  // The two strongest are described as the strongest, by name.
  assert.match(CAPABILITY_COPY.secrets.risk, /strongest thing on this list/)
  assert.match(CAPABILITY_COPY.network.risk, /DISCLOSURE, not a fence/)
  // And the weakest is allowed to say so, rather than inventing a hazard.
  assert.match(CAPABILITY_COPY.skin.risk, /Almost none/)
})

test('every capability the package asked for gets a row, including declined ones', () => {
  const html = packageMarkup(entry())
  for (const capability of entry().requested) {
    assert.ok(html.includes(`data-capability="${capability}"`), `${capability} has no row`)
  }
  // The three declined ones are present AND marked as declined.
  for (const capability of ['storage', 'settings', 'skin']) {
    assert.match(html, new RegExp(`is-withheld"[^>]*data-capability="${capability}"`),
      `${capability} was declined and must still be shown`)
  }
  assert.equal((html.match(/is-allowed/g) || []).length, 2)
  assert.equal((html.match(/is-withheld/g) || []).length, 3)
})

test('a capability this build cannot describe still gets a row, and is described as the strongest one', () => {
  const html = capabilityRowMarkup(entry({ requested: ['futureThing'], granted: [] }), 'futureThing')
  assert.ok(html.includes('data-capability="futureThing"'))
  assert.match(html, /no description for this capability/)
  assert.match(html, /treat it as the strongest thing on the list/)
  // Unchecked: an undescribed capability is never pre-allowed.
  assert.ok(!html.includes(' checked'))
})

test('a declined capability is unticked and an allowed one is ticked', () => {
  const allowed = capabilityRowMarkup(entry(), 'subprocess')
  const declined = capabilityRowMarkup(entry(), 'storage')
  assert.ok(allowed.includes('checked'))
  assert.ok(!declined.includes('checked'))
  assert.match(allowed, /Allowed<\/span>/)
  assert.match(declined, /Not allowed<\/span>/)
})

test('the state sentence leads with the answer and names the gap', () => {
  assert.match(stateSentence(entry()), /^Allowed 2 of the 5 things it asked for\./)
  assert.match(stateSentence(entry()), /you have not allowed that/)
  assert.match(stateSentence(entry({ granted: [], inForce: [], withheld: entry().requested })),
    /^Not allowed anything\. Installing a plugin grants it nothing/)
  assert.match(stateSentence(entry({ granted: entry().requested, withheld: [] })),
    /^Allowed everything it asked for/)
  assert.match(stateSentence(entry({ revoked: { at: '2026-09-26T13:00:00Z', by: 'owner', reason: 'done with it' } })),
    /^Withdrawn\./)
  assert.match(stateSentence(entry({ revoked: { at: '2026-09-26T13:00:00Z', by: 'owner', reason: 'done with it' } })),
    /kept so you can see that it once could/)
})

test('a tool shows the plugin\'s claim and what it actually counts as', () => {
  const html = toolRowMarkup(entry().tools[0])
  assert.match(html, /plugin\.notes\.reindex/)
  // Both halves: hiding the disagreement and repeating the claim are both wrong.
  // The quotes arrive escaped, which is the point of drawing this through esc().
  assert.match(html, /The plugin calls this &quot;reads on this computer&quot;/)
  assert.match(html, /it counts as writes inside its own folder/)
  assert.match(html, /It asks you every time it runs\./)
  const waived = toolRowMarkup({ ...entry().tools[0], approvalWaived: true })
  assert.match(waived, /may run without asking/)
  // When they agree, one sentence, not a contrived contrast.
  assert.equal(effectRaisedSentence('local-read', 'local-read'), 'Counts as: reads on this computer.')
})

test('a contribution the plugin was not allowed to make is not counted', () => {
  // It ships three roles, settings and a skin; only roles is in force.
  assert.equal(contributionLine(entry()), 'It also adds 3 roles.')
  assert.equal(contributionLine(entry({ inForce: ['subprocess'] })), 'It adds nothing besides its tools right now.')
  assert.equal(contributionLine(entry({ inForce: ['roles', 'settings', 'skin'] })),
    'It also adds 3 roles, settings of its own, limits it holds itself to and a few colours.')
})

test('nothing a plugin wrote is drawn as markup', () => {
  const hostile = entry({
    displayName: '<img src=x onerror=alert(1)>',
    summary: '"><script>alert(2)</script>',
    tools: [{
      name: 'plugin.x.<svg/onload=alert(3)>',
      summary: '</p><iframe src=javascript:alert(4)>',
      declaredEffect: 'local-read', effect: 'local-read', approvalRequested: true, approvalWaived: false,
    }],
  })
  const html = packageMarkup(hostile)
  for (const forbidden of ['<img', '<script', '<svg', '<iframe']) {
    assert.ok(!html.includes(forbidden), `${forbidden} survived into the page`)
  }
  assert.ok(html.includes('&lt;img'))
  assert.ok(html.includes('&lt;script'))
  // The attribute the digest goes into is quoted, and the digest is hex, so the
  // escape there is belt and braces -- but the tool name is not, and it is drawn
  // inside an element rather than an attribute.
  assert.ok(html.includes('&lt;svg/onload=alert(3)&gt;'))
})

test('a refused directory is named with its refusal, verbatim and escaped', () => {
  const html = refusedMarkup({
    directory: 'broken<script>',
    code: 'PLUGIN_MANIFEST_UNKNOWN_FIELD',
    message: 'plugin.json has a field this version does not understand: trustLevel. An unrecognised field is refused '
      + 'rather than ignored, because a host that skips what it cannot read cannot tell you what it let through.',
  })
  assert.match(html, /is not loaded as a plugin, so nothing in it is running/)
  // The engine's sentence names the field and what to do; summarising it here
  // would throw away the only part that helps.
  assert.match(html, /trustLevel/)
  assert.match(html, /refused\s+rather than ignored/)
  assert.ok(!html.includes('<script>'))
})

test('no plugins and could-not-read are different answers', () => {
  const empty = emptyMarkup('/\x68ome/redacted-profile/.local/state/plugin-packages')
  assert.match(empty, /No plugins added/)
  assert.match(empty, /There is no store/)

  const broken = unavailableMarkup({ ok: false, code: 'PLUGIN_HOST_UNAVAILABLE', reason: 'the payload is absent' })
  assert.match(broken, /could not be read/)
  assert.match(broken, /not the same as having no plugins/)
  assert.match(broken, /Nothing has been changed/)

  // pageMarkup must route a failure to the second, never the first.
  assert.equal(pageMarkup({ ok: false, code: 'X', reason: 'y' }), unavailableMarkup({ ok: false, code: 'X', reason: 'y' }))
  assert.match(pageMarkup({ ok: true, root: '/p', packages: [], refused: [] }), /No plugins added/)
})

test('the page carries the identity note and the restart note', () => {
  const html = pageMarkup({ ok: true, root: '/p', packages: [entry()], refused: [] })
  // Without the first, a person cannot understand why a plugin they edited lost
  // its permissions. Without the second, they grant something and wonder why
  // nothing appeared.
  assert.match(html, /identified by its contents, not by its name or a version number/)
  assert.match(html, /takes effect the next time you open it/)
})

test('the short id is a prefix for a person and the full digest is kept for the machine', () => {
  const full = entry().sha256
  assert.equal(shortId(full), 'febdd76b95423581')
  assert.equal(shortId(full).length, 16)
  const html = packageMarkup(entry())
  // The decision is made against all 64: the card carries the whole digest, and
  // the prefix is only what is shown.
  assert.ok(html.includes(`data-sha256="${full}"`))
  assert.ok(html.includes(`title="${full}"`))
})

test('withheldSentence reads as a sentence for one, two and three', () => {
  assert.equal(withheldSentence([]), '')
  assert.equal(withheldSentence(['network']), 'It asked to reach the network, and you have not allowed that.')
  assert.equal(withheldSentence(['storage', 'network']),
    'It asked to keep its own records and reach the network, and you have not allowed that.')
  assert.match(withheldSentence(['storage', 'network', 'skin']), /records, reach the network and set a few colours/)
})

test('a read-only page disables every control rather than hiding them', () => {
  const html = packageMarkup(entry(), { writable: false })
  // Hiding a control makes a declined capability look like one nobody asked
  // about. Disabling keeps the whole request visible.
  assert.equal((html.match(/ disabled/g) || []).length >= entry().requested.length, true)
  for (const capability of entry().requested) {
    assert.ok(html.includes(`data-capability="${capability}"`))
  }
})

// --- THE SKIN, THE PLUGIN'S OWN SETTINGS, AND ITS CLAIMED LIMITS ---------------

test('a skin value is re-validated here, not trusted because the engine checked it', () => {
  // These crossed a process boundary on the way to a style attribute. This is the
  // one place in the file where a bad value stops being text and becomes CSS, and
  // "the other side already checked" precedes every such bug.
  assert.equal(skinStyle({ '--plugin-accent': '#0b6', '--plugin-radius': '5px' }),
    '--plugin-accent:#0b6;--plugin-radius:5px')
  // Each of these is an escape attempt, and each is DROPPED rather than corrected.
  const hostile = skinStyle({
    '--plugin-accent': 'red;position:fixed;top:0;left:0;width:100vw',
    '--plugin-radius': 'url(https://example.test/leak.png)',
    '--plugin-border': '#fff) ; body { display:none',
    '--plugin-surface': '#fafafa',
    '--plugin-surface-text': '#111111',
  })
  assert.equal(hostile, '--plugin-surface:#fafafa;--plugin-surface-text:#111111')
  for (const forbidden of ['position', 'url(', 'body', '}']) {
    assert.ok(!hostile.includes(forbidden), `${forbidden} survived into a style attribute`)
  }
  // A property the vocabulary does not name cannot be smuggled in.
  assert.equal(skinStyle({ 'position': 'fixed', '--plugin-anything': '#000' }), '')
  assert.equal(skinStyle(null), '')
})

test('a plugin’s surface colour is used only with a text colour that can be read on it', () => {
  // 1.0.50 release review F8: a surface alone kept the theme's text colour on it,
  // so a light surface in a dark theme hid the permissions and "Withdraw
  // everything". Red before (a surface alone was emitted), green after.
  assert.equal(skinStyle({ '--plugin-surface': '#fafafa' }), '', 'a surface alone would leave the theme’s text on it')
  assert.equal(skinStyle({ '--plugin-surface-text': '#ffffff' }), '', 'a text colour alone would sit on the theme’s background')
  assert.equal(skinStyle({ '--plugin-surface': '#fafafa', '--plugin-surface-text': '#eeeeee' }), '', 'too little contrast to read')
  assert.equal(skinStyle({ '--plugin-surface': '#fafafa', '--plugin-surface-text': '#111', '--plugin-accent': '#0b6' }),
    '--plugin-accent:#0b6;--plugin-surface:#fafafa;--plugin-surface-text:#111')
  assert.ok(contrastRatio('#ffffff', '#000000') > 20 && contrastRatio('#777777', '#777777') === 1)
  const css = readFileSync(new URL('../../src/plugins.css', import.meta.url), 'utf8')
  assert.match(css, /\.plugin-card \{[^}]*color: var\(--plugin-surface-text, inherit\)/, 'the card’s text follows the surface')
})

test('a badge is text, never a custom property', () => {
  // `content: var(--x)` needs quoting rules a plugin-supplied string should not be
  // near, so the badge is drawn as escaped text and never emitted as CSS.
  assert.equal(badgeWord({ '--plugin-badge': 'Notes' }), 'Notes')
  assert.equal(badgeWord({ '--plugin-badge': '"><script>alert(1)</script>' }), '')
  assert.equal(badgeWord({ '--plugin-badge': 'x'.repeat(40) }), '')
  assert.equal(badgeWord({}), '')
  const html = packageMarkup(entry())
  assert.match(html, /<span class="plugin-badge">Notes<\/span>/)
  assert.ok(!html.includes('--plugin-badge'), 'the badge is not a CSS property')
  assert.match(html, /style="--plugin-accent:#0b6;--plugin-radius:5px"/)
})

test("a plugin's own setting shows what it grants AND what it risks", () => {
  const html = settingRowMarkup(entry().settings[0])
  assert.match(html, /Rebuild the index when a folder is opened/)
  assert.match(html, /On by default/)
  assert.match(html, /opening a folder rebuilds its index/)
  // Both lists, separately. The host refuses a row that omits either, and a screen
  // that dropped the risk line would make that requirement pointless.
  assert.match(html, /plugin-setting-gains/)
  assert.match(html, /a folder opens straight away/)
  assert.match(html, /plugin-setting-risks/)
  assert.match(html, /miss a note that was added/)
})

test('a select setting names its options and a number names its unit', () => {
  const select = settingRowMarkup({
    label: 'Refutation rounds', control: 'select', default: 'Two', options: ['One', 'Two', 'Three'],
    consequence: 'How many snapshots of the index are kept.',
    capabilities: ['One uses less disk.'], risks: ['One keeps less history.'],
  })
  assert.match(select, /Two of One \/ Two \/ Three/)
  const number = settingRowMarkup({
    label: 'Keep evidence for', control: 'number', default: 90, unit: 'days',
    consequence: 'How long evidence is kept.', capabilities: ['Longer is arguable.'], risks: ['Longer means more on disk.'],
  })
  assert.match(number, /90 days by default/)
})

test("claimed limits are labelled as the package's own words, not as enforcement", () => {
  const html = limitsMarkup(entry().limits)
  assert.match(html, /Limits this plugin says it holds itself to/)
  // The sentence that stops a stranger's prose borrowing the product's authority.
  assert.match(html, /the package\u2019s own words, not something this app enforces/)
  assert.match(html, /decided by the permissions above and by your tool answers/)
  assert.match(html, /No note is deleted without asking/)
  assert.match(html, /always need a person/)
  assert.equal(limitsMarkup(null), '')
})

test('a refusal code is kept for support in data-code, never printed as text a person reads', () => {
  // The product's rule (tools/test/refusal-copy.test.mjs): a person reads the
  // engine's sentence; the code stays reachable in an attribute for a support
  // conversation. Each of the three places this page names a refusal is checked.
  const visibleText = html => html.replace(/<[^>]*>/g, ' ')
  const cases = [
    ['refusedMarkup', 'PLUGIN_MANIFEST_UNKNOWN_FIELD',
      refusedMarkup({ directory: 'broken', code: 'PLUGIN_MANIFEST_UNKNOWN_FIELD', message: 'plugin.json has a field this version does not understand.' })],
    ['unavailableMarkup', 'PLUGIN_HOST_UNAVAILABLE',
      unavailableMarkup({ ok: false, code: 'PLUGIN_HOST_UNAVAILABLE', reason: 'the payload is absent' })],
    ['contributionRefusedMarkup', 'PLUGIN_SETTING_INVALID',
      contributionRefusedMarkup([{ what: 'settings', code: 'PLUGIN_SETTING_INVALID', message: 'rows[0].risks is missing.' }])],
  ]
  for (const [name, code, html] of cases) {
    assert.ok(html.includes(`data-code="${code}"`), `${name} dropped the code instead of keeping it in data-code`)
    assert.ok(!visibleText(html).includes(code), `${name} prints ${code} where a person reads it`)
  }
  // An attribute is still escaped: the code comes from the engine, but a refused
  // directory's code field is not something this page gets to trust.
  assert.ok(refusedMarkup({ directory: 'd', code: 'X" onmouseover="alert(1)', message: 'm' })
    .includes('data-code="X&quot; onmouseover=&quot;alert(1)"'))
})

test('a contribution whose file is broken is named, and the rest still works', () => {
  const html = contributionRefusedMarkup([{
    what: 'settings',
    code: 'PLUGIN_SETTING_INVALID',
    message: 'settings/rows.json.rows[0].risks must be a non-empty array of plain statements.',
  }])
  assert.match(html, /Parts of this plugin could not be read/)
  assert.match(html, /Its settings/)
  assert.match(html, /risks must be a non-empty array/)
  assert.match(html, /Everything else about this plugin still works/)
  assert.equal(contributionRefusedMarkup([]), '')
  // And a broken rows file does not take the card's tools or capabilities with it.
  const card = packageMarkup(entry({ settings: [], contributionsRefused: [{ what: 'settings', code: 'X', message: 'y' }] }))
  assert.match(card, /plugin\.notes\.reindex/)
  assert.match(card, /data-capability="subprocess"/)
  assert.match(card, /could not be read/)
})

test('nothing a plugin wrote reaches the page as markup, settings and limits included', () => {
  const hostile = entry({
    settings: [{
      label: '<img src=x onerror=alert(1)>', control: 'toggle', default: false,
      consequence: '</p><script>alert(2)</script>',
      capabilities: ['<svg onload=alert(3)>'], risks: ['"><iframe src=javascript:alert(4)>'],
    }],
    limits: {
      note: null,
      hardBlocks: [{ rule: '<script>a</script>', why: '</p><img src=x onerror=alert(5)>' }],
      requiresHumanApproval: ['<iframe>'],
    },
  })
  const html = packageMarkup(hostile)
  for (const forbidden of ['<img', '<script', '<svg', '<iframe']) {
    assert.ok(!html.includes(forbidden), `${forbidden} survived into the page`)
  }
})

/* FOUND IN THE REAL APP (1.0.49 plugins walk, 2026-09-27), three sentences a person
   read on this page and should not have. */
test('the withdrawn line gives a date a person reads, ends its sentences, and drops the page’s own note', () => {
  const line = stateSentence(entry({ revoked: { at: '2026-09-27T06:24:26.717Z', by: 'owner', reason: 'withdrawn from the plugins page' } }))
  assert.doesNotMatch(line, /\d{4}-\d{2}-\d{2}T/, 'no raw timestamp')
  assert.doesNotMatch(line, /withdrawn from the plugins page/, 'the note this page files with every withdrawal says nothing')
  assert.match(line, /^Withdrawn\. You allowed this plugin until [^.]*2026[^.]*, and then withdrew it\. It can do nothing/)
  // A reason somebody actually wrote is kept, quoted, as its own sentence.
  const reasoned = stateSentence(entry({ revoked: { at: '2026-09-27T06:24:26.717Z', by: 'owner', reason: 'done with it' } }))
  assert.match(reasoned, /withdrew it\. The reason given: “done with it”\. It can do nothing/)
  const undated = stateSentence(entry({ revoked: { at: null, by: 'owner', reason: null } }))
  assert.match(undated, /^Withdrawn\. You allowed this plugin earlier, and then withdrew it\. It can do nothing/)
  const bad = stateSentence(entry({ revoked: { at: 'not a date', by: 'owner', reason: null } }))
  assert.match(bad, /^Withdrawn\. You allowed this plugin earlier, and then withdrew it\./)
})

test('a setting labels what it grants and what it risks in words, not only by colour', () => {
  const html = settingRowMarkup(entry().settings[0])
  assert.match(html, /<p class="plugin-setting-list-label">What you gain<\/p><ul class="plugin-setting-gains">/)
  assert.match(html, /<p class="plugin-setting-list-label">What could go wrong<\/p><ul class="plugin-setting-risks">/)
})

test('the boxes say a program you allow runs as you, and claim no fence that does not exist', () => {
  // 1.0.50 release review F1. Nothing confines a plugin's program: it runs as the
  // person, with no separate account, file fence or network fence. Only its
  // environment is built by the app. The boxes said "within that folder", "No other
  // plugin can read it", and left "Reach the network" reading like a switch. Red
  // before, green after.
  const all = Object.values(CAPABILITY_COPY).map(copy => `${copy.grants} ${copy.risk}`).join(' ')
  assert.doesNotMatch(all, /within that folder/, 'a program is not confined to its folder')
  assert.doesNotMatch(all, /No other plugin can read it/, 'another plugin’s program runs as the same person')
  assert.doesNotMatch(all, /no part of your environment/, 'it is not handed the environment, but it can read files')
  const { subprocess, storage, network } = CAPABILITY_COPY
  assert.match(subprocess.risk, /runs as you/)
  assert.match(subprocess.risk, /any file you can, including sign-in files/)
  assert.match(subprocess.risk, /can use the network/)
  assert.match(subprocess.risk, /does not hand it your provider keys or sign-ins/, 'the true half of the old claim stays')
  assert.match(storage.risk, /including another plugin’s, can read it/)
  assert.match(network.risk, /does not control the network/)
  assert.match(network.risk, /whether or not you tick it/)
})

test('a card says when an allowed plugin is not running, in the engine’s own words', () => {
  // 1.0.50 release review F6. Red before (no such line; runningMarkup absent).
  const card = packageMarkup(entry({ running: { state: 'not-running', reason: 'This plugin needs python3 <b>now</b>.' } }))
  assert.match(card, /Not running\. It did not start when the app opened/)
  assert.match(card, /This plugin needs python3 &lt;b&gt;now&lt;\/b&gt;\./, 'escaped: part of it is a stranger’s text')
  assert.match(packageMarkup(entry({ running: { state: 'not-yet' } })), /Not running yet\. What you allowed takes effect the next time you open the app\./)
  const partly = packageMarkup(entry({ running: { state: 'partly', parts: [{ part: 'roles', message: 'roles/x.json is not readable JSON.' }] } }))
  assert.match(partly, /part of it did not start/)
  assert.match(partly, /Its roles:/)
  for (const running of [undefined, null, { state: 'running' }]) {
    assert.doesNotMatch(packageMarkup(entry({ running })), /plugin-running/)
  }
})

test('a plugin’s own settings are said to be shown only, because nothing can change them yet', () => {
  // 1.0.50 release review F7: no control, no stored value, nothing passed to the
  // plugin -- while the box said "Its switches change how the plugin behaves".
  // Red before, green after.
  assert.doesNotMatch(CAPABILITY_COPY.settings.risk, /switches change how the plugin behaves/)
  assert.match(CAPABILITY_COPY.settings.risk, /you cannot change them, and the plugin is not told any value/)
  assert.match(packageMarkup(entry({ inForce: ['settings'] })), /Shown only\. In this version you cannot change these/)
})

test('the secrets and record boxes say they do nothing in this version', () => {
  // 1.0.50 release review F10: neither capability has a channel to the plugin's
  // programs. Red before, green after.
  assert.match(CAPABILITY_COPY.secrets.grants, /Not in this version: there is no way to store a secret for a plugin yet/)
  assert.match(CAPABILITY_COPY.auditLog.grants, /Not in this version: its programs have no way to write to the record yet/)
  assert.doesNotMatch(CAPABILITY_COPY.auditLog.risk, /^It can add to the record/)
})

test('the records box says an update starts empty and removing the plugin leaves the folder', () => {
  // 1.0.50 release review F12. Red before, green after.
  assert.match(CAPABILITY_COPY.storage.risk, /an update starts empty, and nothing removes the folder when you remove the plugin/)
  assert.doesNotMatch(CAPABILITY_COPY.storage.risk, /until you remove the plugin/)
})

test('only roles the engine accepted are counted, never the manifest’s list of files', () => {
  // 1.0.50 release review F3: the page counted the manifest's role files, so a
  // role file the engine refused was still "It also adds 1 role". Red before.
  const refused = [{ what: 'roles', code: 'PLUGIN_ROLE_INVALID', message: 'roles/x.json id must be lowercase words joined by underscores.' }]
  assert.equal(contributionLine(entry({ roleCount: 1, roles: [], contributionsRefused: refused, inForce: ['roles'] })),
    'It adds nothing besides its tools right now.')
  assert.equal(contributionLine(entry({ roleCount: 3, roles: ['notes-code_reviewer', 'notes-archivist'], inForce: ['roles'] })),
    'It also adds 2 roles.')
  assert.equal(contributionLine(entry({ roleCount: 2, roles: ['notes-archivist', 'notes-curator'], shadowedRoles: ['notes-archivist'] })),
    'It also adds 1 role. Its role “notes-archivist” is not used, because one of your own roles has that name, and yours is the one in force.')
  const card = packageMarkup(entry({ roleCount: 1, roles: [], contributionsRefused: refused, inForce: ['roles'] }))
  assert.doesNotMatch(card, /adds 1 role/)
  assert.match(card, /Parts of this plugin could not be read/)
})

test('a plugin role hidden by a role of the person’s own is not counted, and is named', () => {
  // HP-34: a role the person wrote with the same id wins, and the page still said
  // "It also adds 2 roles".
  assert.equal(contributionLine(entry({ roleCount: 2, shadowedRoles: ['notes-archivist'] })),
    'It also adds 1 role. Its role “notes-archivist” is not used, because one of your own roles has that name, and yours is the one in force.')
  assert.equal(contributionLine(entry({ roleCount: 2, shadowedRoles: ['notes-archivist', 'notes-curator'] })),
    'It adds nothing besides its tools right now. Its roles “notes-archivist” and “notes-curator” are not used, because your own roles have those names, and yours are the ones in force.')
  assert.equal(contributionLine(entry({ roleCount: 2, shadowedRoles: [] })), 'It also adds 2 roles.')
  assert.ok(contributionLine(entry({ roleCount: 1, shadowedRoles: ['<b>x</b>'] })).includes('<b>x</b>'),
    'the line is text; packageMarkup escapes it where it is drawn')
  assert.match(packageMarkup(entry({ roleCount: 1, shadowedRoles: ['<b>x</b>'] })), /&lt;b&gt;x&lt;\/b&gt;/)
})
