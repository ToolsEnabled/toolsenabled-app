/* THE CONTROL THAT WIPES A WORKING CONFIGURATION MUST ASK FIRST.
 *
 * WHAT SHIPPED. skip() replaced every answer with the safe defaults and APPLIED
 * them -- every write flag off, autonomy back to observe, any hand-picked folder
 * dropped -- on one press, with no warning and no confirmation.
 *
 * ON FIRST RUN THAT IS CORRECT and must stay that way: there is nothing to lose,
 * and a step with no exit is a trap. tools/test/setup-profile.test.mjs pins that
 * this control exists, so the fix may never be "hide it".
 *
 * THE RETURNING CUSTOMER IS THE CASE. Settings offers "Walk through setup
 * again", and its own description promises "Nothing is written until you finish
 * it, and leaving partway changes nothing". resumeStep sends a completed profile
 * straight to the REVIEW screen -- the last one -- so the person arrives holding
 * their real answers, and the leftmost control in that action bar reset all of
 * them. The screen they were promised could not change anything was the screen
 * whose first control changed everything.
 *
 * WHY THIS IS A SOURCE READING. src/views/setup.js imports stylesheets, so node
 * cannot load it; tools/test/settings-one-click.test.mjs source-pins this same
 * view for the same stated reason, and the packaged drivers cover the live
 * press. This asserts the RULE and its three parts. It would not catch a
 * mis-wired paint(); that is the packaged suite's job.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SETUP_VIEW = path.join(HERE, '..', '..', 'src', 'views', 'setup.js')
const SOURCE = readFileSync(SETUP_VIEW, 'utf8')

/* Comments stripped: this view explains itself at length, and every phrase this
   suite looks for appears in its prose. A rule a comment can satisfy is not a
   rule. */
const CODE = SOURCE
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')

function bodyOf(code, name) {
  const start = code.indexOf(`function ${name}(`)
  if (start < 0) return null
  const open = code.indexOf('{', start)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1
    else if (code[i] === '}') {
      depth -= 1
      if (depth === 0) return code.slice(open, i + 1)
    }
  }
  return null
}

test('the guard can see the function it is about', () => {
  assert.ok(SOURCE.length > 20_000, 'setup.js did not load')
  assert.ok(bodyOf(CODE, 'skip'), 'skip() not found -- rewrite this guard with it')
})

test('skip does not reset a configured profile on the first press', () => {
  const skip = bodyOf(CODE, 'skip')
  assert.match(CODE, /const initiallyConfigured = liveWalk\?\.initiallyConfigured \?\? state\.configured/)
  assert.match(skip, /initiallyConfigured/,
    'skip() must know whether there is an existing configuration to destroy; without that it wipes a returning customer unwarned')
  assert.match(skip, /skipArmed/,
    'skip() must arm on the first press and act on the second')

  /* The arming branch must RETURN. If it falls through, the confirmation is
     decorative and the wipe still happens on press one -- which would look
     exactly like a fix while being none. */
  const armed = skip.slice(skip.indexOf('skipArmed'))
  assert.match(armed.slice(0, 220), /return/,
    'the arming branch must return before applying anything, or the first press still wipes')
})

test('the destructive work still happens on the second press', () => {
  /* The other way to "fix" this wrongly is to arm forever and never act. */
  const skip = bodyOf(CODE, 'skip')
  assert.match(skip, /SAFE_ANSWERS/, 'the reset must still be reachable')
  assert.match(skip, /writeStoredProfile/, 'and must still be recorded')
  assert.match(skip, /navigate\(/, 'and must still leave the walkthrough')
})

test('first run keeps its one-press exit, because a step with no exit is a trap', () => {
  /* setup-profile.test.mjs pins that this control is rendered. The confirmation
     must therefore be conditional on there being something to lose -- never a
     second press imposed on somebody who has configured nothing. */
  const skip = bodyOf(CODE, 'skip')
  assert.match(skip, /if\s*\(\s*initiallyConfigured\s*&&/,
    'the confirmation must be gated on the configuration at entry, so a fresh install still leaves in one press')
})

test('the label says what the press will do, everywhere it is drawn', () => {
  assert.match(CODE, /function skipLabel\s*\(/,
    'the three places this control is drawn must share one label function, or they will disagree about what a press does')
  const label = bodyOf(CODE, 'skipLabel')
  assert.match(label, /initiallyConfigured/, 'the label must depend on whether anything would be lost')
  assert.match(label, /skipArmed/, 'and on whether the control is already armed')

  /* No site may keep a hardcoded label: that is how three drawings of one
     control come to promise three different things. */
  assert.equal((CODE.match(/>Skip the rest for now</g) || []).length, 0,
    'a hardcoded skip label remains; every site must render skipLabel()')
  assert.ok((CODE.match(/skipLabel\(\)/g) || []).length >= 3,
    'all three draw sites must render the shared label')
})

test('an arming press left behind is disarmed by any other interaction', () => {
  /* Otherwise an arm at 10:00 and an unrelated press at 10:05 combine into a
     confirmation nobody remembers giving. */
  assert.match(CODE, /if\s*\(\s*skipArmed\s*\)\s*\{\s*skipArmed\s*=\s*false/,
    'any other press must clear the armed state')
})
