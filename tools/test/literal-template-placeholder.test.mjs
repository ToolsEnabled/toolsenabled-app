/* A `${...}` THAT SHIPS TO THE GLASS AS SEVEN LITERAL CHARACTERS.
 *
 * WHAT WAS MEASURED, on the packaged shell in a Linux container, 2026-08-25,
 * driving first run with nothing set up. Question 2 of the setup walkthrough
 * offered a live, enabled, hit-testable button whose accessible name was
 *
 *     ${esc(skipLabel())}
 *
 * and so did question 3 and the review screen. All three take their action row
 * from actionsMarkup() in src/views/setup.js, whose skip branch was written as
 *
 *     ${skip ? '<button ... >${esc(skipLabel())}</button>' : ''}
 *
 * A SINGLE-QUOTED STRING INSIDE A TEMPLATE LITERAL. The outer template
 * interpolates the ternary; the inner string is ordinary text, so its own
 * `${...}` is never evaluated and reaches the DOM verbatim. The sibling lines
 * for Back and Continue directly beneath it, and the identical skip button on
 * the account step at line ~544, all use backticks and all render correctly --
 * which is why this was invisible in review: the file is right everywhere else.
 *
 * WHY NOTHING ELSE CAUGHT IT.
 *   - `vite build` is happy: it is a perfectly valid string.
 *   - tools/check-unbound-identifiers.mjs is happy, and correctly so: `esc` and
 *     `skipLabel` are both bound in that file. The names are fine. They are
 *     simply never called.
 *   - tools/check-plain-language.mjs and tools/check-composed-output.mjs read
 *     strings a person is meant to read; this string is markup.
 *   - tools/test/setup-skip-confirms.test.mjs pins what skip() DOES on press
 *     and never looks at what the button SAYS.
 *   - the packaged drivers press the control by its data attribute, which is
 *     intact, so the press worked and the label was never asserted.
 *
 * THE RULE. In a file that builds its screens from template literals, a `${` in
 * a NON-template string literal is always a mistake: there is no way for it to
 * interpolate, and no reason to write those characters on purpose. Stated that
 * way it is exact -- measured across all 138 modules under src/, this rule
 * produced one hit, and the hit was the defect.
 *
 * The separation of "template content" from "a real string literal" is the hard
 * part, and it is not attempted here: tools/lib/user-visible-strings.mjs already
 * owns a walker that knows a quote inside a template is text, that a `/"/g` is a
 * regular expression and not a string, and that a nested literal inside a
 * substitution is its own literal. That walker is reused rather than re-derived.
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { extractStringLiterals, withoutComments } from '../lib/user-visible-strings.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..', '..')
const SRC = path.join(REPO, 'src')

/**
 * Every non-template string literal in one module that carries a `${`.
 *
 * Exported shape is deliberately the finding, not a boolean: a gate that can
 * only say "no" is a gate nobody can act on.
 */
function deadPlaceholders(source) {
  const found = []
  for (const literal of extractStringLiterals(withoutComments(source))) {
    if (literal.quote === '`') continue
    const text = literal.chunks.map(chunk => chunk.text).join('')
    if (text.includes('${')) found.push({ line: literal.line, quote: literal.quote, text })
  }
  return found
}

function modulesUnder(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) { out.push(...modulesUnder(full)); continue }
    if (/\.(js|mjs|cjs)$/.test(name)) out.push(full)
  }
  return out
}

/* ---------- the rule is exercised with values, never by reading itself ---------- */

test('a placeholder inside a single-quoted string is reported', () => {
  const found = deadPlaceholders('const row = `<div>${on ? \'<b>${esc(name())}</b>\' : \'\'}</div>`')
  assert.equal(found.length, 1, 'the dead placeholder was not reported')
  assert.match(found[0].text, /\$\{esc\(name\(\)\)\}/)
  assert.equal(found[0].quote, "'")
})

test('the same markup written with backticks is NOT reported', () => {
  const found = deadPlaceholders('const row = `<div>${on ? `<b>${esc(name())}</b>` : \'\'}</div>`')
  assert.deepEqual(found, [], 'correct interpolation must not be flagged')
})

test('a quote character inside template markup is template text, not a literal', () => {
  /* The false positive that makes a naive scan useless: every view in this
     product writes `class="${x}"`, and the quotes there are content. */
  const found = deadPlaceholders('const row = `<div class="${cls}" data-x="${esc(id)}">hello</div>`')
  assert.deepEqual(found, [], 'attribute quotes inside a template are not string literals')
})

test('a literal with no placeholder in it is left alone', () => {
  assert.deepEqual(deadPlaceholders("const label = 'Skip the rest for now'"), [])
})

/* ---------- and then applied to the product ---------- */

test('the extraction reaches the tree it claims to measure', () => {
  const modules = modulesUnder(SRC)
  assert.ok(modules.length > 100, `only ${modules.length} modules found under src/ -- the walk did not reach the tree`)
})

test('no module under src/ ships a ${...} that can never interpolate', () => {
  const offences = []
  for (const file of modulesUnder(SRC)) {
    let found
    try {
      found = deadPlaceholders(readFileSync(file, 'utf8'))
    } catch (error) {
      /* "could not read" is not "clean". A walker that loses its place must
         fail the gate, never pass it quietly. */
      assert.fail(`${path.relative(REPO, file)}: the string walker did not finish -- ${error.message}`)
    }
    for (const hit of found) {
      offences.push(`${path.relative(REPO, file)}:${hit.line}  ${hit.quote}${hit.text.slice(0, 160)}${hit.quote}`)
    }
  }
  assert.deepEqual(offences, [],
    `these placeholders reach the screen as literal characters:\n  ${offences.join('\n  ')}`)
})
