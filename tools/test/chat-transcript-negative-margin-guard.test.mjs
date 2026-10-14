/* NO UNACCOUNTED-FOR NEGATIVE MARGIN REACHES THE TRANSCRIPT -- THE WHOLE BUG
 * CLASS, IN EVERY STYLESHEET THAT ACTUALLY PAINTS IT, NOT JUST ONE OF THEM.
 *
 * Owner: "text overlaps tool use." tools/test/chat-action-run-overlap.test.mjs
 * pins the ONE cause that was found and fixed: an unscoped
 * `.chat-action + .chat-action { margin-top: calc(-1 * var(--s1)); }` drew a
 * tool call's own name and command 4px up into the row above it, because the
 * -4px it spent was borrowed from a flex gap (.chat-log's own) that did not
 * exist in the nested context every real run actually uses.
 *
 * THAT FIX SCOPES ONE SELECTOR. It does not stop a SECOND selector from
 * doing the identical thing to a DIFFERENT pair of rows -- a future author
 * reaching for the same "close two rows up" trick (`.msg + .something {
 * margin-top: -Npx }`, or borrowing a gap from a flex context a nested
 * selector does not actually sit in) would reintroduce this exact defect
 * with a clean run of `chat-action-run-overlap.test.mjs`, because that file
 * only ever reads the one selector it was written for.
 *
 * THIS FILE USED TO READ ONE STYLESHEET, AND CALLED THAT "THE WHOLE
 * STYLESHEET". It scanned every rule in src/styles.css for a selector that
 * could reach `.chat-log` and a body that sets a negative margin. That was
 * never actually the whole of what paints the transcript's cascade:
 * src/main.js imports every view MODULE at the top level --
 *
 *   import { homeView } from './views/home.js'
 *   import { computersView } from './views/computers.js'
 *   import { agentView } from './views/agent.js'
 *   ...(comms, guide, settings, tools, setup, account, subscribe, ...)
 *
 * -- all static `import`, none of them a lazy `import()`. Each view's own
 * `import '../whatever.css'` rides in with it. There is no route-level code
 * splitting here to work around later: the moment the app boots, EVERY one
 * of those stylesheets is already in the one document the transcript itself
 * renders into, and CSS classes are global -- nothing here is a scoped
 * module class -- so any of them can address `.chat-action`, `.msg`, `.md-p`
 * and the rest of this file's own TRANSCRIPT_SELECTOR set exactly as
 * directly as styles.css can.
 *
 * home.css proves this is not theoretical: its own turn-fold reuses the
 * transcript's `.chat-action-mark` disclosure triangle directly, and it
 * carries more rules matching TRANSCRIPT_SELECTOR than any file here except
 * styles.css itself. board.css (the rail chat), comms.css, agent.css,
 * guide.css and phone-canvas.css each scope real overrides onto the same
 * selectors for their own surfaces. A negative margin landing in any of
 * those six files would draw exactly the owner's defect on exactly the
 * pages the transcript renders on, and the old file-scoped guard could never
 * have seen it.
 *
 * MEASURED before widening this file: scanning every stylesheet under src/
 * with the identical selector and negative-margin patterns below finds 246
 * rules total that match TRANSCRIPT_SELECTOR, spread across eight files
 * (191 in styles.css, 21 in home.css, 15 in board.css, 5 in comms.css, 4
 * each in agent.css, guide.css and phone-canvas.css, 1 in morphs.css; the
 * other 24 stylesheets under src/ match none of them at all). Exactly one
 * of those 246 sets a negative margin -- the rule
 * chat-action-run-overlap.test.mjs already proved dead-but-harmless. So this
 * is a coverage widening, not a second fix: nothing found here is live
 * today. The point is that this file would actually catch it if it were.
 *
 * WHY A HAND-ROLLED SCAN RATHER THAN A CSS LIBRARY: unchanged from before --
 * this repository takes no CSS-parsing dependency, and a `selector { ... }`
 * brace-balance scan is the same method chat-action-run-overlap.test.mjs and
 * chat-msg-markdown.test.mjs already use for exact-selector pins. The
 * per-file discovery below (`readdirSync(SRC).filter(name =>
 * name.endsWith('.css'))`) is not new either: it is
 * tools/test/frameless-animation-safety.test.mjs's own pattern for "every
 * stylesheet under src/", reused rather than reinvented so a css file this
 * suite forgets is the same file every other multi-sheet guard would forget.
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')

/* Every stylesheet the app actually ships, name -> its own text. Discovered,
   not hand-listed, for the same reason the header above gives: a hand-listed
   set of filenames drifts the moment a new one is added and nobody remembers
   to update a guard three files away. */
const sheets = readdirSync(SRC).filter((name) => name.endsWith('.css'))
  .map((name) => ({ name, css: readFileSync(path.join(SRC, name), 'utf8') }))

/* Comments first, always -- a comment's own PROSE routinely contains text
   that looks like a declaration (this very file's header does, and so does
   the rule comment directly above `.chat-log > .chat-action + .chat-action`
   in src/styles.css: "fired the same -4px"), and prose is not a rule. */
function stripComments(css) { return css.replace(/\/\*[\s\S]*?\*\//g, '') }

/* Every innermost `selector { declarations }` pair. A flat, non-brace-aware
   scan finds these correctly even across @media/@keyframes nesting: the
   character class excludes braces, so the engine cannot match through a
   nested `{` and instead settles on the nearest enclosing pair -- the
   OUTER "@media (...) {" is left as unconsumed text with no partner, which
   is exactly what should happen to it here. Verified by the sanity check
   below rather than trusted by construction. */
function ruleBlocks(css) {
  const blocks = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let match
  while ((match = re.exec(css))) {
    blocks.push({ selector: match[1].trim(), body: match[2] })
  }
  return blocks
}

/* A rule body carries a negative margin if ANY margin-family property (the
   shorthand or a longhand: margin-top/right/bottom/left) is set to a bare
   negative number or a calc() that starts negative. Matches "-4px", "-.5em",
   "calc(-1 * var(--s1))"; does not match "0", a positive value, or a value
   that merely CONTAINS the substring "-" for an unrelated reason (a custom
   property name, a var() fallback) because the dash has to immediately
   follow the colon-and-optional-space that ends the property name. */
const NEGATIVE_MARGIN = /\bmargin(?:-(?:top|right|bottom|left))?\s*:\s*(-\s*[\d.]|calc\(\s*-)/i

/* Selectors that could ever match something INSIDE `.chat-log` -- the
 * transcript src/components.js's buildChat() paints, which this lane's own
 * defect and fix live in. Deliberately broad rather than an exact class
 * list: `.msg`, every `.chat-*` prefix (chat-action, chat-action-run,
 * chat-action-run-body, chat-context, chat-approval, chat-diff-card via its
 * [data-chat-diff-card] attribute selector, chat-msg-text, ...), and every
 * `.md-*` block chat-markdown.js's renderChatMarkdown() can emit inside a
 * message. A selector that does not mention any of these cannot reach a row
 * in this log regardless of what it sets, so it is out of this test's scope
 * on purpose -- this file guards the transcript, not the whole product.
 */
const TRANSCRIPT_SELECTOR = /\.msg\b|\.chat-[a-z-]|\.md-[a-z-]|data-chat-diff/i

/* Formats one rule the identical way whether it came from a real scan or
   from the pin below, so the two can never drift apart over whitespace. */
function formatRule(file, selector, body) {
  return `${file}: ${selector} {${body}}`.replace(/\s+/g, ' ').trim()
}

/* THE ONE RULE ALLOWED TO CARRY A NEGATIVE MARGIN INTO THE TRANSCRIPT, ACROSS
 * EVERY STYLESHEET. File-qualified now that more than one sheet is read, so
 * a rule of this exact shape appearing in a DIFFERENT file is still an
 * offender, not a silent match on selector text alone. The body string below
 * is copied verbatim (including its surrounding spaces) from between the
 * braces in src/styles.css, so a change to its VALUE -- someone widening the
 * -4px into something that no longer matches the 4px chat-log actually
 * overspends -- fails here too, not only silently drifting from the sibling
 * suite that first proved this exact shape safe. */
const KNOWN_SAFE_FILE = 'styles.css'
const KNOWN_SAFE_SELECTOR = '.chat-log > .chat-action + .chat-action'
const KNOWN_SAFE_BODY = ' margin-top: calc(-1 * var(--s1)); '
const ALLOWED_NEGATIVE_MARGIN_RULES = Object.freeze([
  formatRule(KNOWN_SAFE_FILE, KNOWN_SAFE_SELECTOR, KNOWN_SAFE_BODY),
])

test('the brace scan is sane before it is trusted for the real assertion: every stylesheet under src/ parses to well-formed rules', () => {
  assert.ok(sheets.length > 20, `only found ${sheets.length} .css files under src/; SRC path resolution is broken, not the count of stylesheets`)
  const styles = sheets.find((sheet) => sheet.name === KNOWN_SAFE_FILE)
  assert.ok(styles, `src/${KNOWN_SAFE_FILE} must be among the discovered sheets`)
  assert.ok(ruleBlocks(stripComments(styles.css)).length > 500, `only found rules in src/${KNOWN_SAFE_FILE} below the old single-file floor; the brace scan is broken, not the stylesheet`)
  let totalBlocks = 0
  for (const sheet of sheets) {
    const blocks = ruleBlocks(stripComments(sheet.css))
    totalBlocks += blocks.length
    for (const { selector } of blocks) {
      assert.ok(selector.length > 0 && !selector.includes('/*'), `${sheet.name}: a malformed "selector" survived comment-stripping: ${JSON.stringify(selector.slice(0, 80))}`)
    }
  }
  assert.ok(totalBlocks > 2000, `only found ${totalBlocks} rules across every src/*.css combined; the brace scan is broken, not the stylesheets`)
})

test('no selector reaching into the transcript carries a negative margin, in any stylesheet the app loads, other than the one rule already proved safe', () => {
  const offenders = []
  for (const sheet of sheets) {
    const blocks = ruleBlocks(stripComments(sheet.css))
    for (const { selector, body } of blocks) {
      if (!TRANSCRIPT_SELECTOR.test(selector)) continue
      if (!NEGATIVE_MARGIN.test(body)) continue
      offenders.push(formatRule(sheet.name, selector, body))
    }
  }
  assert.deepEqual(
    offenders,
    ALLOWED_NEGATIVE_MARGIN_RULES,
    'a new negative margin reaches a transcript row -- in this file or another stylesheet the app loads alongside it. ' +
      'src/main.js imports every view eagerly, so every src/*.css file shares the transcript\'s cascade from boot, not ' +
      'only src/styles.css. Every entry above the allowed one is the "text overlaps tool use" defect class recurring ' +
      'at a different selector or a different file -- read the rule named in the diff, find the flex gap (if any) it ' +
      'actually has to spend, and scope it the way chat-action-run-overlap.test.mjs already documents for the one ' +
      'rule that needed it.',
  )
})

test('the one allowed rule is still exactly the shape the sibling suite already proved dead-but-harmless', () => {
  const sheet = sheets.find((candidate) => candidate.name === KNOWN_SAFE_FILE)
  assert.ok(sheet, `src/${KNOWN_SAFE_FILE} must be among the discovered sheets`)
  const blocks = ruleBlocks(stripComments(sheet.css))
  const found = blocks.find((block) => block.selector === KNOWN_SAFE_SELECTOR)
  assert.ok(found, `"${KNOWN_SAFE_SELECTOR}" is missing from src/${KNOWN_SAFE_FILE}; re-read this pin (and chat-action-run-overlap.test.mjs) before trusting it`)
  assert.equal(found.body.trim(), KNOWN_SAFE_BODY.trim(), `"${KNOWN_SAFE_SELECTOR}"'s value changed; re-verify against chat-action-run-overlap.test.mjs that the new value is still safely dead code`)
})
