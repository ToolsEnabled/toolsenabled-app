/* THE LEDGER REGISTER'S OWNER-WAITING COLOURS.
 *
 * The owner's words, verbatim: "yellow for owner-asks/proposals, red for real
 * owner-waiting blockers, three colours user-pickable from quick settings,
 * per-theme sets."
 *
 * What this suite holds, and why each part is here rather than somewhere else:
 *
 *  1. THE CLASSIFICATION IS ONE RULE, NOT TWO. ownerWaitingStatus() decides
 *     per record; homeLedgerStatus() decides for the whole ledger. If they ever
 *     disagree, the circle on Home and the rows on Ledger disagree about which
 *     rows the owner is stuck on, which is the one thing a status colour must
 *     never do. Both are driven here with the same records.
 *
 *  2. THE ROW WEARS THE ANSWER. The real builders out of src/views/ledger.js
 *     are run over real record shapes and the rendered `.ledger-line` is read.
 *
 *  3. THE COLOUR THAT ACTUALLY LANDS IS RED, AND YELLOW. Nothing here pins a
 *     property name or a rule's spelling -- a rewritten stylesheet that reaches
 *     the same colours passes. src/ledger.css is parsed, the cascade is
 *     resolved for a row in each state (last rule wins among equal
 *     specificity, which is exactly what makes the owner's answer beat the
 *     record's), every var() is followed, and the HUE of the result is
 *     measured: blockers land in the red band, asks in the yellow band, in all
 *     five themes, and never the same colour as each other.
 *
 *  4. THE PICK ROUND-TRIPS, PER THEME. A colour chosen through the quick
 *     settings picker's own writer is read back through the same reader
 *     mountHomeStatusColors paints from, and shows up as the row's colour --
 *     while a second theme keeps its own.
 *
 *  5. THE PICKER IS OFFERED WHERE IT ACTS. It was drawn on Home only; the
 *     register at #/ledger is the other surface those colours reach.
 *
 * DECLARED BOUNDS.
 *  - The cascade reader considers UNCONDITIONAL rules only. Rules nested in an
 *    at-rule are excluded, and test 3 asserts that no at-rule in src/ledger.css
 *    colours a `.ledger-glyph` or a `.ledger-stat-value`, so the exclusion
 *    cannot hide an override.
 *  - The no-JavaScript fallback's theme tokens are read from
 *    src/theme-refinements.css alone. src/main.js imports it AFTER
 *    './styles.css', so at equal `:root` specificity it is the last writer of
 *    --s-serious and --s-warn, and it defines both for all five themes.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { homeLedgerStatus, ownerWaitingStatus } from '../../src/home-ledger-status.js'
import { THEME_CHOICES } from '../../src/theme-choice.js'
import {
  HOME_STATUS_COLOR_SETTINGS,
  currentHomeStatusColor,
  resolvedHomeStatusColor,
  setHomeStatusColor,
} from '../../src/home-status-colors.js'
import { WRITE_ACTION_FLAGS } from '../../src/write-flags.js'
import { PROFILE_LOCAL_PRESERVED, PROFILE_PRODUCT_VALUES, WORKING_PROFILES, workingProfilePlan } from '../../src/settings-profile-policy.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = relative => readFileSync(path.join(REPO, relative), 'utf8')
const THEMES = THEME_CHOICES.map(choice => choice.id)

/* ------------------------------------------------------------------ colour */

/* Hue in degrees from a six-digit hex colour, and null for anything that is
   not one -- an unresolved var(), a color-mix(), a keyword. Hue is what "red"
   and "yellow" are words for; a test that compared hex strings would be pinning
   one designer's exact swatch instead of the owner's sentence. A null hue is
   neither red nor yellow, so a colour this reader cannot measure can never
   satisfy an assertion by accident; it fails it. */
function hueOf(value) {
  if (!/^#[\da-f]{6}$/i.test(String(value).trim())) return null
  const hex = String(value).trim()
  const [r, g, b] = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255)
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min
  if (delta === 0) return null
  const hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4
  return (hue * 60 + 360) % 360
}

/* HSL saturation, for the same reason hue is measured: a status colour has to
   be the colour, not a tint of the page's ink. Measured on the untouched tree
   2026-09-18, Ember's neutral --ink-25 (#d9bac3) sits at hue 344 -- inside any
   honest "red" arc -- on a saturation of 0.29, while every red and gold token
   in this product clears 0.45. So "red" is an arc AND a floor, and the quiet
   warm grey the rail already used is not mistaken for an alarm. */
function satOf(value) {
  if (!/^#[\da-f]{6}$/i.test(String(value).trim())) return null
  const hex = String(value).trim()
  const [r, g, b] = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255)
  const max = Math.max(r, g, b), min = Math.min(r, g, b), light = (max + min) / 2
  if (max === min) return 0
  return (max - min) / (1 - Math.abs(2 * light - 1))
}

/* The two bands, stated once. Red straddles 0deg, so it is written as two
   arcs; yellow/amber is the single arc every gold token in this product sits
   in. They do not touch, which is the point: a colour cannot satisfy both. */
const SATURATED = 0.4
const isRed = value => {
  const hue = hueOf(value)
  return hue !== null && satOf(value) >= SATURATED && (hue >= 330 || hue <= 20)
}
const isYellow = value => {
  const hue = hueOf(value)
  return hue !== null && satOf(value) >= SATURATED && hue >= 30 && hue <= 65
}

/* --------------------------------------------------------------- css model */

const stripComments = text => text.replace(/\/\*[\s\S]*?\*\//g, '')

/* Every rule in a stylesheet, with the at-rule prelude it is nested inside
   ('' at the top level). A brace-balanced walk, because a regex cannot tell a
   nested rule from a top-level one. */
function rulesOf(text) {
  const source = stripComments(text)
  const rules = []
  const open = []
  let index = 0, buffer = ''
  while (index < source.length) {
    const char = source[index]
    if (char === '{') {
      const prelude = buffer.trim()
      buffer = ''
      index += 1
      if (prelude.startsWith('@')) { open.push(prelude); continue }
      let depth = 1, body = ''
      while (index < source.length && depth > 0) {
        if (source[index] === '{') depth += 1
        else if (source[index] === '}') { depth -= 1; if (depth === 0) break }
        body += source[index]
        index += 1
      }
      index += 1
      rules.push({ at: open.join(' '), selector: prelude, body })
      continue
    }
    if (char === '}') { open.pop(); buffer = ''; index += 1; continue }
    buffer += char
    index += 1
  }
  return rules
}

function declarationsOf(body) {
  const declarations = new Map()
  let depth = 0, current = ''
  const parts = []
  for (const char of body) {
    if (char === '(') depth += 1
    if (char === ')') depth -= 1
    if (char === ';' && depth === 0) { parts.push(current); current = ''; continue }
    current += char
  }
  parts.push(current)
  for (const part of parts) {
    const at = part.indexOf(':')
    if (at < 0) continue
    const name = part.slice(0, at).trim()
    if (name !== '') declarations.set(name, part.slice(at + 1).trim())
  }
  return declarations
}

/* Split a selector at the top level only: a comma or a space inside
   `[...]` or `:is(...)` belongs to the piece, not between pieces. */
function splitTop(text, separators) {
  const parts = []
  let depth = 0, quote = '', current = ''
  for (const char of text) {
    if (quote !== '') { current += char; if (char === quote) quote = ''; continue }
    if (char === '"' || char === "'") { quote = char; current += char; continue }
    if (char === '(' || char === '[') depth += 1
    if (char === ')' || char === ']') depth -= 1
    if (depth === 0 && separators.includes(char)) { parts.push(current); current = ''; continue }
    current += char
  }
  parts.push(current)
  return parts.map(part => part.trim()).filter(Boolean)
}

/* SELECTOR PIECES THIS READER UNDERSTANDS, and what it does with the rest.
   Classes, attribute tests, :is()/:where()/:not() (nesting and all), :root and
   element names are matched. Any OTHER pseudo-class or pseudo-element --
   :hover, :focus-visible, ::before -- makes the selector not match, which is
   the truth for an element at rest and not a shrug: none of them can colour a
   resting glyph. Anything that is neither is thrown on, because a piece this
   reader silently skipped would make a real rule invisible and this suite
   green for the wrong reason. */
function balanced(rest, open, close) {
  let depth = 0
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === open) depth += 1
    else if (rest[index] === close) { depth -= 1; if (depth === 0) return index + 1 }
  }
  throw new Error(`unbalanced ${open} in "${rest}"`)
}

function compoundMatches(compound, element) {
  if (!element) return false
  let rest = compound
  while (rest !== '') {
    let taken = 0, match
    if ((match = /^\.([a-z0-9_-]+)/i.exec(rest))) {
      taken = match[0].length
      if (!element.classes.includes(match[1])) return false
    } else if ((match = /^#([a-z0-9_-]+)/i.exec(rest))) {
      taken = match[0].length
      if (element.id !== match[1]) return false
    } else if (rest.startsWith('[')) {
      taken = balanced(rest, '[', ']')
      const test = /^\[\s*([a-z-]+)\s*(?:([~|^$*]?=)\s*"([^"]*)"\s*)?\]$/i.exec(rest.slice(0, taken))
      if (!test) throw new Error(`this reader does not understand the attribute test "${rest.slice(0, taken)}"`)
      const value = element.attrs[test[1]]
      if (value === undefined) return false
      if (test[2] === '=' && value !== test[3]) return false
    } else if (/^:(not|is|where|matches)\(/i.test(rest)) {
      const name = /^:([a-z-]+)\(/i.exec(rest)[1].toLowerCase()
      const openAt = rest.indexOf('(')
      taken = openAt + balanced(rest.slice(openAt), '(', ')')
      const inner = rest.slice(openAt + 1, taken - 1)
      const any = splitTop(inner, ',').some(part => selectorMatches(part, element))
      if (name === 'not' ? any : !any) return false
    } else if (rest.startsWith(':root')) {
      taken = ':root'.length
      if (element.tag !== 'html') return false
    } else if (/^::?[a-z-]+\(/i.test(rest)) {
      const openAt = rest.indexOf('(')
      taken = openAt + balanced(rest.slice(openAt), '(', ')')
      return false
    } else if (/^::?[a-z-]+/i.test(rest)) {
      return false
    } else if ((match = /^([a-z][a-z0-9-]*|\*)/i.exec(rest))) {
      taken = match[0].length
      if (match[1] !== '*' && element.tag !== match[1]) return false
    } else {
      throw new Error(`this reader does not understand the selector piece "${rest}"`)
    }
    rest = rest.slice(taken)
  }
  return true
}

const COMBINATORS = new Set(['>', '+', '~'])

/* element is { tag, classes, attrs, parent }. Read right to left, the way the
   cascade does, so a selector whose subject is not this element costs one
   compound test and nothing else. `+` and `~` never match: these fixtures model
   a parent chain and no siblings, and a sibling rule cannot be assumed to apply
   -- the at-rule guard in test 3 is what covers the register's one `~` rule. */
function selectorMatches(selector, element) {
  const parts = splitTop(selector, ' \t\n')
  if (parts.length === 0) return false
  if (!compoundMatches(parts[parts.length - 1], element)) return false
  let node = element.parent
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    const part = parts[index]
    if (part === '+' || part === '~') return false
    if (part === '>') {
      index -= 1
      if (index < 0 || !compoundMatches(parts[index], node)) return false
      node = node.parent
      continue
    }
    if (COMBINATORS.has(part)) throw new Error(`unhandled combinator "${part}"`)
    while (node && !compoundMatches(part, node)) node = node.parent
    if (!node) return false
    node = node.parent
  }
  return true
}

/* (ids, classes+attributes+pseudo-classes, elements), the cascade's own
   ordering. :not()/:is() contribute their own argument's weight, as the
   specification says, which is why :not([data-empty]) genuinely outranks the
   rule it is written to survive. */
function specificity(selector) {
  const inner = selector.replace(/:(not|is)\(([^()]*)\)/gi, ' $2 ')
  const ids = (inner.match(/#[a-z0-9_-]+/gi) || []).length
  const classes = (inner.match(/\.[a-z0-9_-]+|\[[^\]]+\]|:[a-z-]+/gi) || []).length
  const elements = (inner.match(/(^|[\s>+~])[a-z][a-z0-9-]*/gi) || []).length
  return [ids, classes, elements]
}

const rankOf = ([a, b, c]) => a * 10000 + b * 100 + c

/* The winning declaration for one property on one element, over a list of
   parsed stylesheets in load order. Later file, then higher specificity, then
   later rule -- the browser's order, and the reason the owner's answer beats
   the record's without either rule shouting !important. */
function cascade(sheets, property, element, { conditional = false } = {}) {
  let best = null
  sheets.forEach((rules, sheet) => {
    rules.forEach((rule, order) => {
      if (!conditional && rule.at !== '') return
      for (const selector of splitTop(rule.selector, ',')) {
        if (selector === '' || !selectorMatches(selector, element)) continue
        const value = declarationsOf(rule.body).get(property)
        if (value === undefined) continue
        const key = [sheet, rankOf(specificity(selector)), order]
        if (!best || key.some((part, index) => part > best.key[index] && key.slice(0, index).every((p, i) => p === best.key[i]))) {
          best = { key, value }
        }
      }
    })
  })
  return best?.value ?? null
}

/* Follow var() chains to a literal. An unresolvable name falls through to its
   own fallback, exactly as a browser does, so the "before JavaScript runs"
   path is measured rather than assumed. */
function resolveValue(value, variables, depth = 0) {
  assert.ok(depth < 12, `var() chain does not terminate: ${value}`)
  const match = /^var\(\s*(--[a-z0-9-]+)\s*(?:,\s*([\s\S]+))?\)$/i.exec(value.trim())
  if (!match) return value.trim()
  const named = variables[match[1]]
  if (named !== undefined) return resolveValue(named, variables, depth + 1)
  /* Nothing defines it and it has no fallback: hand back the text unresolved
     rather than inventing a colour. hueOf() reads that as neither red nor
     yellow, so the assertion that wanted a colour fails and says what it got. */
  if (match[2] === undefined) return value.trim()
  return resolveValue(match[2], variables, depth + 1)
}

/* ------------------------------------------------------------- the fixture */

const LEDGER_CSS = rulesOf(read('src/ledger.css'))
const THEME_CSS = rulesOf(read('src/theme-refinements.css'))

const line = (state, owner) => ({
  tag: 'div',
  classes: ['ledger-line'],
  attrs: { 'data-state': state, ...(owner ? { 'data-owner-status': owner } : {}) },
  parent: null,
})
const glyph = (state, owner) => ({
  tag: 'span', classes: ['ledger-glyph'], attrs: {}, parent: line(state, owner),
})
const tile = (state, { empty = false } = {}) => ({
  tag: 'span',
  classes: ['ledger-stat-value'],
  attrs: {},
  parent: { tag: 'div', classes: ['ledger-stat'], attrs: { 'data-state': state, ...(empty ? { 'data-empty': '' } : {}) }, parent: null },
})

/* The theme's own --s-* tokens, read the way a browser reads them: the :root
   rules of src/theme-refinements.css against an <html data-theme=...>. */
function themeTokens(theme) {
  const root = { tag: 'html', classes: [], attrs: { 'data-theme': theme }, parent: null }
  const tokens = {}
  for (const name of ['--s-serious', '--s-warn', '--s-good', '--ink-25']) {
    const value = cascade([THEME_CSS], name, root)
    if (value !== null) tokens[name] = value
  }
  return tokens
}

/* What mountHomeStatusColors would have put on the page for this theme and
   this storage -- the same reader, not a copy of its arithmetic. */
function paintedVariables(theme, storage = null) {
  const painted = {}
  for (const { status } of HOME_STATUS_COLOR_SETTINGS) {
    painted[`--home-ledger-${status}`] = resolvedHomeStatusColor(status, theme, currentHomeStatusColor(status, storage, theme))
  }
  return painted
}

const glyphColour = (state, owner, variables) =>
  resolveValue(cascade([LEDGER_CSS], 'color', glyph(state, owner)), variables)

const memoryStorage = (initial = {}) => {
  const values = new Map(Object.entries(initial))
  return {
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)) },
    removeItem: key => { values.delete(key) },
    get size() { return values.size },
  }
}

/* --------------------------------------------------------------- the tests */

test('one classification, two readers: a record earns the owner colour Home would give it', () => {
  const nowMs = Date.parse('2026-09-18T12:00:00Z')
  const aggregate = records => homeLedgerStatus({
    ledger: { ok: true, records, chain: { ok: true } }, prompts: { ok: true, prompts: [] }, nowMs,
  })

  for (const record of [{ id: 'T1', status: 'blocked' }, { id: 'T2', status: 'blocked-external' }, { id: 'R3', status: 'blocked' }]) {
    assert.equal(ownerWaitingStatus(record), 'blocked', `${record.id} ${record.status} is a real owner-waiting blocker`)
    assert.equal(aggregate([record]).status, 'blocked')
  }
  for (const record of [{ id: 'R1', status: 'proposed' }, { id: 'A1', status: 'open' }, { id: 'P1', status: 'open' }, { id: 'T4', status: 'proposed' }]) {
    assert.equal(ownerWaitingStatus(record), 'attention', `${record.id} ${record.status} is an owner-ask`)
    assert.equal(aggregate([record]).status, 'attention')
  }
  for (const record of [{ id: 'T1', status: 'open' }, { id: 'R1', status: 'open' }, { id: 'T2', status: 'in-progress' }, { id: 'T3', status: 'recurring' }, { id: 'R2', status: 'partial' }]) {
    assert.equal(ownerWaitingStatus(record), null, `${record.id} ${record.status} is work, not something the owner owes`)
    assert.equal(aggregate([record]).status, 'clear')
  }
  for (const status of ['done', 'answered', 'approved', 'declined', 'removed', 'superseded', 'not-possible-as-asked', 'cancelled']) {
    assert.equal(ownerWaitingStatus({ id: 'A9', status }), null, `a ${status} record still asks for the owner`)
  }
  assert.equal(ownerWaitingStatus({ id: 'T1', status: 'blocked', removedAt: '2026-09-18' }), null)
  assert.equal(ownerWaitingStatus({ id: 'T1', status: 'blocked', removed: true }), null)
  assert.equal(ownerWaitingStatus(null), null)
  assert.equal(ownerWaitingStatus({ status: 'blocked' }), null)

  // A blocker outranks an ask on the same register, the way it does per record.
  assert.equal(aggregate([{ id: 'A1', status: 'open' }, { id: 'T1', status: 'blocked-external' }]).status, 'blocked')
})

test('a ledger row wears the owner mark only when the owner is the one waiting', async () => {
  const builders = await rowBuilders()
  const lineAttr = markup => /<div class="ledger-line"([^>]*)>/.exec(markup)?.[1] ?? ''
  const ownerOf = markup => /data-owner-status="([a-z]+)"/.exec(lineAttr(markup))?.[1] ?? null

  const request = (status, extra = {}) =>
    builders.requestMarkup({ id: 'R1', status, gateCount: 0, unmetGateCount: 0, ...extra })

  assert.equal(ownerOf(request('blocked')), 'blocked')
  assert.equal(ownerOf(request('blocked-external')), 'blocked')
  assert.equal(ownerOf(request('proposed')), 'attention')
  assert.equal(ownerOf(request('open')), null, 'an R at open is work, not an owner-ask')
  assert.equal(ownerOf(request('in-progress')), null)
  assert.equal(ownerOf(request('done')), null)
  assert.equal(ownerOf(request('removed', { removed: true })), null)

  const ask = builders.kindRecordMarkup({ id: 'A7', status: 'open', words: 'Which region?' }, 'A')
  assert.equal(ownerOf(ask), 'attention', 'an unanswered A is the owner-ask the yellow is for')
  const task = builders.kindRecordMarkup({ id: 'T7', status: 'open', words: 'Ship it' }, 'T')
  assert.equal(ownerOf(task), null, 'a T at the same status must not borrow the ask colour')
  const stuck = builders.kindRecordMarkup({ id: 'T8', status: 'blocked-external', words: 'Needs the vendor' }, 'T')
  assert.equal(ownerOf(stuck), 'blocked')

  // The record's own state is untouched: the mark is a second axis, not a rename.
  assert.match(lineAttr(request('proposed')), /data-state="proposed"/)
  assert.match(lineAttr(stuck), /data-state="blocked"/)

  // The kind decides, not the id's first letter: an A-shaped id on a T record
  // that carries its own kind stays uncoloured.
  assert.equal(ownerOf(builders.kindRecordMarkup({ id: 'A9', status: 'open', kind: 'T' }, 'A')), null)
})

test('blockers land red and owner-asks land yellow, in every theme, and never the same colour', () => {
  for (const rule of LEDGER_CSS) {
    if (rule.at === '') continue
    const declarations = declarationsOf(rule.body)
    if (!declarations.has('color')) continue
    assert.ok(!/ledger-glyph|ledger-stat-value/.test(rule.selector),
      `an at-rule colours the rail or the strip (${rule.at} ${rule.selector}); this reader would not see it`)
  }

  for (const theme of THEMES) {
    const painted = { ...themeTokens(theme), ...paintedVariables(theme) }
    const blocked = glyphColour('blocked', 'blocked', painted)
    const ask = glyphColour('proposed', 'attention', painted)
    const openAsk = glyphColour('open', 'attention', painted)

    assert.ok(isRed(blocked), `${theme}: a blocked row is not red (${blocked}, hue ${hueOf(blocked)})`)
    assert.ok(isYellow(ask), `${theme}: a proposal is not yellow (${ask}, hue ${hueOf(ask)})`)
    assert.ok(isYellow(openAsk), `${theme}: an open owner-ask is not yellow (${openAsk}, hue ${hueOf(openAsk)})`)
    assert.notEqual(blocked.toLowerCase(), ask.toLowerCase(), `${theme}: blockers and asks are the same colour`)

    // An ordinary open task is still the rail's quiet neutral: the register did
    // not become a page of alarm colours.
    const plain = glyphColour('open', null, painted)
    assert.ok(!isRed(plain) && !isYellow(plain), `${theme}: an ordinary open row picked up a status colour (${plain})`)
    assert.notEqual(plain.toLowerCase(), blocked.toLowerCase(), `${theme}: an ordinary open row is the blocker colour`)
    assert.notEqual(plain.toLowerCase(), ask.toLowerCase(), `${theme}: an ordinary open row is the ask colour`)

    // The strip agrees with the rail, and a tile reading zero still recedes.
    const blockedTile = resolveValue(cascade([LEDGER_CSS], 'color', tile('blocked')), painted)
    const askTile = resolveValue(cascade([LEDGER_CSS], 'color', tile('proposed')), painted)
    assert.equal(blockedTile.toLowerCase(), blocked.toLowerCase(), `${theme}: the BLOCKED figure and the blocked rows are different reds`)
    assert.equal(askTile.toLowerCase(), ask.toLowerCase(), `${theme}: the waiting-for-you figure and the ask rows are different yellows`)
    const emptyTile = resolveValue(cascade([LEDGER_CSS], 'color', tile('blocked', { empty: true })), painted)
    assert.ok(!isRed(emptyTile), `${theme}: a BLOCKED count of zero is flying an alarm colour (${emptyTile})`)
  }
})

test('with no stored pick and no JavaScript the fallback is still red and yellow, per theme', () => {
  const seen = new Map()
  for (const theme of THEMES) {
    const tokens = themeTokens(theme)
    assert.ok(tokens['--s-serious'] && tokens['--s-warn'], `${theme} has no serious/warn token of its own`)
    const blocked = glyphColour('blocked', 'blocked', tokens)
    const ask = glyphColour('proposed', 'attention', tokens)
    assert.ok(isRed(blocked), `${theme}: the no-JavaScript blocked colour is not red (${blocked})`)
    assert.ok(isYellow(ask), `${theme}: the no-JavaScript ask colour is not yellow (${ask})`)
    seen.set(theme, `${blocked}|${ask}`)
  }
  // Per-theme means the sets are not one set wearing five names.
  assert.ok(new Set(seen.values()).size > 1, 'every theme resolved to the same pair of colours')
})

test('a colour picked in quick settings reaches the register rows, and each theme keeps its own', () => {
  const storage = memoryStorage()
  const events = { dispatchEvent() {} }
  const picked = { blocked: '#c2402f', attention: '#c8a01e' }

  for (const [status, value] of Object.entries(picked)) {
    assert.equal(setHomeStatusColor(status, value, { storage, events, theme: 'white' }), value)
  }
  const white = { ...themeTokens('white'), ...paintedVariables('white', storage) }
  assert.equal(glyphColour('blocked', 'blocked', white).toLowerCase(), picked.blocked)
  assert.equal(glyphColour('proposed', 'attention', white).toLowerCase(), picked.attention)
  assert.equal(glyphColour('open', 'attention', white).toLowerCase(), picked.attention)
  // Still the owner's mapping after the pick: this is a colour choice, not a
  // way to make a blocker read as an ask.
  assert.ok(isRed(glyphColour('blocked', 'blocked', white)))
  assert.ok(isYellow(glyphColour('proposed', 'attention', white)))

  for (const theme of THEMES.filter(id => id !== 'white')) {
    const other = { ...themeTokens(theme), ...paintedVariables(theme, storage) }
    assert.notEqual(glyphColour('blocked', 'blocked', other).toLowerCase(), picked.blocked,
      `picking a colour on White repainted ${theme}`)
    assert.ok(isRed(glyphColour('blocked', 'blocked', other)), `${theme} lost its own red`)
  }

  // Cobalt gets its own answer, and White keeps the one above it.
  setHomeStatusColor('blocked', '#8f2233', { storage, events, theme: 'cobalt' })
  const cobalt = { ...themeTokens('cobalt'), ...paintedVariables('cobalt', storage) }
  assert.equal(glyphColour('blocked', 'blocked', cobalt).toLowerCase(), '#8f2233')
  assert.equal(glyphColour('blocked', 'blocked', { ...themeTokens('white'), ...paintedVariables('white', storage) }).toLowerCase(), picked.blocked)

  // Default puts the theme's own colour back, and only for that theme.
  setHomeStatusColor('blocked', 'auto', { storage, events, theme: 'cobalt' })
  assert.equal(currentHomeStatusColor('blocked', storage, 'cobalt'), 'auto')
  assert.ok(isRed(glyphColour('blocked', 'blocked', { ...themeTokens('cobalt'), ...paintedVariables('cobalt', storage) })))
  assert.equal(glyphColour('blocked', 'blocked', { ...themeTokens('white'), ...paintedVariables('white', storage) }).toLowerCase(), picked.blocked)

  assert.throws(() => setHomeStatusColor('blocked', 'not-a-colour', { storage, events, theme: 'white' }), RangeError)
  assert.throws(() => setHomeStatusColor('unknown', '#112233', { storage, events, theme: 'white' }), RangeError)
})

test('quick settings offers the three colours on the page they colour, Ledger included', async () => {
  const { renderQuickSettings } = await quickSettingsModule()
  const restore = installBrowserGlobals()
  try {
    for (const route of ['ledger', 'home']) {
      const body = drawerBody()
      renderQuickSettings(body, route)
      const inputs = [...body.innerHTML.matchAll(/data-home-color="([a-z]+)"/g)].map(match => match[1])
      assert.deepEqual(inputs.sort(), ['attention', 'blocked', 'clear'], `${route} does not offer the three colours`)
      assert.equal([...body.innerHTML.matchAll(/data-home-color-reset="/g)].length, 3, `${route} offers no way back to the theme default`)
      assert.match(body.innerHTML, /Saved for this theme/, `${route} does not say the choice is per theme`)
    }
    const other = drawerBody()
    renderQuickSettings(other, 'metrics')
    assert.equal(/data-home-color=/.test(other.innerHTML), false, 'a page these colours do not reach offers the picker anyway')
  } finally {
    restore()
  }
})

test('switching a working profile leaves a picked status color exactly where it was', () => {
  /* WHAT A PROFILE SWITCH DOES TO A PICKED COLOR: nothing, and this is where
     that is measured rather than asserted in prose. A working profile stages
     every value in `plan.product`, `plan.setup.writeFlags` and `plan.resources`
     and writes nothing else, so a setting that appears in none of the three
     cannot be moved by choosing a profile. The three color ids appear in none
     of them, for every preset at every permission tier.

     Before this, the Settings coverage gate was RED on this branch: the three
     rows were writable Settings rows classified nowhere, and that gate wants an
     EXPLAINED exclusion, not three more entries. The reasons are asserted here
     too, because src/settings-profile-settings.js prints them verbatim in the
     "Kept as you chose" list -- an unexplained key would show the person a row
     name with nothing beside it. */
  const ids = HOME_STATUS_COLOR_SETTINGS.map(setting => setting.id)
  assert.equal(ids.length, 3)
  const flagIds = WRITE_ACTION_FLAGS.map(flag => flag.id)

  for (const profile of WORKING_PROFILES) {
    for (const tier of ['guided', 'standard', 'unrestricted']) {
      const plan = workingProfilePlan(profile.id, { tier, writeFlagIds: flagIds, totalBytes: 32 * 1024 ** 3 })
      for (const id of ids) {
        assert.equal(Object.hasOwn(plan.product, id), false, `${profile.id}/${tier} stages ${id} as a policy value`)
        assert.equal(Object.hasOwn(plan.setup.writeFlags, id), false, `${profile.id}/${tier} stages ${id} as a write flag`)
        assert.equal(Object.hasOwn(plan.resources, id), false, `${profile.id}/${tier} stages ${id} as a resource value`)
      }
    }
  }
  for (const id of ids) {
    assert.equal(Object.hasOwn(PROFILE_PRODUCT_VALUES, id), false, `${id} is a value some profile column sets`)
  }

  /* Explained, and explained one row at a time: three rows sharing one sentence
     would read as a group note and tell a person nothing about the row it sits
     beside. */
  const reasons = ids.map(id => {
    const reason = PROFILE_LOCAL_PRESERVED[id]
    assert.equal(typeof reason, 'string', `${id} is not classified in PROFILE_LOCAL_PRESERVED`)
    assert.ok(reason.length > 40, `${id} has no real reason beside it: ${JSON.stringify(reason)}`)
    return reason
  })
  assert.equal(new Set(reasons).size, 3, 'the three status colors share a sentence')
  const others = Object.entries(PROFILE_LOCAL_PRESERVED).filter(([id]) => !ids.includes(id)).map(([, reason]) => reason)
  for (const reason of reasons) assert.equal(others.includes(reason), false, 'a status color borrowed another row\'s reason')

  /* And the store itself: computing every plan touches no saved color. */
  const storage = memoryStorage()
  setHomeStatusColor('blocked', '#4b2d5e', { storage, events: { dispatchEvent() {} }, theme: 'white' })
  for (const profile of WORKING_PROFILES) workingProfilePlan(profile.id, { tier: 'standard', writeFlagIds: flagIds, totalBytes: 32 * 1024 ** 3 })
  assert.equal(currentHomeStatusColor('blocked', storage, 'white'), '#4b2d5e')
})

/* -------------------------------------------------------------- harnessing */

/* The row builders, lifted the way tools/test/ledger-rows-remove.test.mjs
   lifts them: src/views/ledger.js imports a stylesheet, so a plain node run
   cannot load it, and the builders between STATE and ledgerView use only their
   arguments plus the ledger copy and the owner classification -- both imported
   here for real, never stubbed, so a drift between the row's colour and Home's
   turns this suite red instead of passing against a fake. */
async function rowBuilders() {
  const source = read('src/views/ledger.js')
  const start = source.indexOf('const STATE = {')
  const end = source.indexOf('export function ledgerView()')
  assert.ok(start > 0 && end > start, 'the builders no longer sit between STATE and ledgerView; move this extractor')
  const copy = pathToFileURL(path.join(REPO, 'src', 'ledger-copy.js')).href
  const owner = pathToFileURL(path.join(REPO, 'src', 'home-ledger-status.js')).href
  const module = `import { HIDE_ROW, ROW_ACTIONS, RESOLVE_STATUSES, RESOLVE_NOTE, SUPERSEDED_NOTE } from ${JSON.stringify(copy)}\n`
    + `import { ownerWaitingStatus } from ${JSON.stringify(owner)}\n`
    + `${source.slice(start, end)}\n`
    + 'export { requestMarkup, kindRecordMarkup }\n'
  return import(`data:text/javascript;base64,${Buffer.from(module, 'utf8').toString('base64')}`)
}

/* The drawer, with exactly two things replaced: stylesheets, which node cannot
   import, and src/views/computers.js, whose own stylesheet imports are what
   makes it unloadable here. Every module that decides anything about this
   assertion -- the picker, the colour store, the theme list -- is the real one. */
let quickSettingsRegistered = false
async function quickSettingsModule() {
  if (!quickSettingsRegistered) {
    quickSettingsRegistered = true
    register(`data:text/javascript,${encodeURIComponent(`
      const stub = (source) => ({ format: 'module', source, shortCircuit: true })
      export async function resolve(specifier, context, nextResolve) {
        if (specifier.endsWith('.css')) return { url: 'ledger-colors:css', shortCircuit: true }
        if (specifier === './views/computers.js') return { url: 'ledger-colors:computers', shortCircuit: true }
        return nextResolve(specifier, context)
      }
      export async function load(url, context, nextLoad) {
        if (url === 'ledger-colors:css') return stub('')
        if (url === 'ledger-colors:computers') return stub('export const rangeFill = () => {}')
        return nextLoad(url, context)
      }
    `)}`, import.meta.url)
  }
  return import('../../src/quick-settings.js')
}

function drawerBody() {
  return { innerHTML: '', querySelector() { return null }, querySelectorAll() { return [] } }
}

function installBrowserGlobals(theme = 'white') {
  const names = ['document', 'window', 'localStorage', 'fetch', 'CustomEvent']
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  const values = {
    document: {
      documentElement: { dataset: { theme }, style: { getPropertyValue: () => '', setProperty() {} } },
      body: { style: {}, classList: { contains: () => false, toggle() {} } },
    },
    window: { dispatchEvent() {}, addEventListener() {}, removeEventListener() {} },
    localStorage: memoryStorage(),
    fetch: async () => ({ ok: false }),
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail } },
  }
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  return () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    }
  }
}

/* THE PURCHASES TAB HIDES THE LEDGER'S OWN STRIP (T1360). The view sets the
   hidden attribute; `.ledger-summary { display: grid }` used to beat the
   browser's [hidden] rule, so the strip stayed on screen beside the queue's
   own totals, with two different "Waiting for you" numbers. */
test('a hidden Ledger totals strip is not displayed, and a shown one is still a grid', () => {
  const strip = hidden => ({ tag: 'section', classes: ['ledger-summary'], attrs: hidden ? { hidden: '' } : {}, parent: null })
  assert.equal(cascade([LEDGER_CSS], 'display', strip(true)), 'none', 'the hidden strip is still drawn')
  assert.equal(cascade([LEDGER_CSS], 'display', strip(false)), 'grid')
})

/* A RULE'S CHECKS IN WORDS WRAP IN THEIR RAIL (T1355): "1 of 2 checks still
   open" is wider than the 90px rail, and the meta line does not wrap. */
test('a rule\'s checks, said in words, wrap inside their rail', () => {
  const gates = { tag: 'span', classes: ['ledger-agent'], attrs: { 'data-gates': '' }, parent: { tag: 'span', classes: ['ledger-meta'], attrs: {}, parent: null } }
  assert.equal(cascade([LEDGER_CSS], 'white-space', gates), 'normal')
})

/* A QUESTION'S STATUS AND ITS PACKAGE NEVER SIT ON TOP OF EACH OTHER (T1340):
   the two facts are a wrapping run, not two fixed 90px/62px rails of text
   that cannot wrap. */
test('a question row\'s status and package wrap beside each other instead of overlapping', () => {
  const meta = { tag: 'span', classes: ['ledger-meta'], attrs: {}, parent: { tag: 'div', classes: ['ledger-record', 'is-question'], attrs: {}, parent: null } }
  assert.equal(cascade([LEDGER_CSS], 'display', meta), 'flex')
  assert.equal(cascade([LEDGER_CSS], 'flex-wrap', meta), 'wrap')
  assert.equal(cascade([LEDGER_CSS], 'white-space', meta), 'normal')
})
