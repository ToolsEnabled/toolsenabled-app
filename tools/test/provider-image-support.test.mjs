/* THE PICTURE EITHER GOES OR THE PERSON IS TOLD, IN WORDS THEY CAN ACT ON.
 *
 * T18. Before the fix, a pasted picture reached the model on exactly one of
 * five providers, and on the other four the person got a code at the end of a
 * send they had already committed to. shell/provider-image-support.cjs is what
 * lets the app say so BEFORE the send instead. Everything here calls it with
 * values.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { supportFor, pictureNotSentSentence } = require('../../shell/provider-image-support.cjs')

test('the providers whose adapters actually carry a picture are the ones marked as carrying it', () => {
  /* claude: claude-cli-adapter builds an image content block, proven against
     the real CLI. codex: codex-adapter sends { type: 'localImage', path }. */
  assert.equal(supportFor('claude').delivers, true)
  assert.equal(supportFor('codex').delivers, true)
})

test('the providers whose adapters refuse a picture are marked as refusing it', () => {
  for (const provider of ['gemini', 'grok', 'local']) {
    assert.equal(supportFor(provider).delivers, false, `${provider} cannot carry a picture in this build`)
    assert.ok(supportFor(provider).because.length > 0, `${provider} must say why, not just no`)
  }
})

test('an unknown provider is treated as unable, never as able', () => {
  /* A wrong "no" costs a picture and says so. A wrong "yes" costs the answer,
     silently -- which is the defect this whole task exists to end. */
  for (const unknown of ['', null, undefined, 'something-new', 'CLAUDE']) {
    assert.equal(supportFor(unknown).delivers, false)
  }
})

test('the sentence a person reads names the file, says why, and says their words still went', () => {
  const one = pictureNotSentSentence('local', ['holiday.png'])
  assert.match(one, /holiday\.png/)
  assert.match(one, /cannot look at pictures/)
  assert.match(one, /Your message was sent without it\./)
  /* No code and no absolute path: a person recognises the name on their own
     screen, and neither of the other two helps them decide what to do next. */
  assert.ok(!/MC_AGENT|_UNSUPPORTED|[A-Za-z]:\\\\/.test(one), `the sentence must carry no code or path: ${one}`)
})

test('the sentence counts pictures rather than pretending there was one', () => {
  const many = pictureNotSentSentence('grok', ['a.png', 'b.png', 'c.png'])
  assert.match(many, /3 pictures were not sent/)
  assert.match(many, /a\.png, b\.png, c\.png/)
  const none = pictureNotSentSentence('grok', [])
  assert.match(none, /The picture was not sent/)
})

test('the reason differs by provider, so the sentence is never a generic apology', () => {
  const local = pictureNotSentSentence('local', ['x.png'])
  const gemini = pictureNotSentSentence('gemini', ['x.png'])
  assert.notEqual(local, gemini)
  assert.match(local, /local model/)
})
