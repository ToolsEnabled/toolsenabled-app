/* WHEN A TOOL CHANGE IS NOT SAVED, THE PAGE SAYS WHY IT WAS NOT.
 *
 * shell/product-account.cjs putSetting() answers six distinct named refusals,
 * each carrying a `reason` written for a person. src/views/tools.js discarded
 * all six and printed one fixed line ending "Sign in, then set it again." For
 * five of the six that instruction is wrong, and it cannot even be aimed at
 * somebody signed out -- persist() takes the signed-out branch, with its own
 * sentence, before this line is reached. Signing in again cannot empty a full
 * settings store, repair a damaged partition, or make a refused disk write
 * succeed.
 *
 * These checks drive saveRefusalSentence with the exact refusal values
 * shell/product-account.cjs constructs, and assert what a person is told. The
 * refusal sentences are read out of the shell source rather than retyped here,
 * so a suite that passes cannot be pinning a copy of them that has drifted.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { saveRefusalSentence } from '../../src/agent-tools-markup.js'

const shellSource = readFileSync(new URL('../../shell/product-account.cjs', import.meta.url), 'utf8')

/* Every refusal putSetting() can answer, with its reason taken from the shell
   itself. If one of these codes stops being produced there, the assertion below
   that each reason is really in that file fails rather than passing quietly. */
const REFUSALS = [
  'ACCOUNT_NOT_SIGNED_IN',
  'ACCOUNT_DATA_BAD_KEY',
  'ACCOUNT_DATA_BAD_VALUE',
  'ACCOUNT_DATA_FULL',
  'ACCOUNT_DATA_WRITE_FAILED',
]

function reasonFor(code) {
  /* refusal(code, reason) -- the reason is the second argument, a single- or
     double-quoted string or a template with no substitution before the cap. */
  const match = new RegExp(`refusal\\('${code}',\\s*(['\`])([^'\`]+)\\1`).exec(shellSource)
  assert.ok(match, `shell/product-account.cjs no longer answers ${code}`)
  return match[2]
}

test('the reason the shell gave is what the person reads', () => {
  for (const code of REFUSALS) {
    const reason = reasonFor(code)
    const said = saveRefusalSentence({ ok: false, code, reason })
    assert.ok(said.includes(reason), `${code}: the shell's reason was dropped. Said: ${said}`)
  }
})

test('the consequence is stated before the reason, every time', () => {
  for (const code of REFUSALS) {
    const said = saveRefusalSentence({ ok: false, code, reason: reasonFor(code) })
    assert.match(said, /^That change was not saved, so nothing on this computer changed\./,
      `${code}: a person is told the reason before they are told nothing changed. Said: ${said}`)
  }
})

test('nobody is told to sign in over a failure signing in cannot fix', () => {
  for (const code of REFUSALS.filter(entry => entry !== 'ACCOUNT_NOT_SIGNED_IN')) {
    const said = saveRefusalSentence({ ok: false, code, reason: reasonFor(code) })
    assert.doesNotMatch(said, /Sign in, then set it again/,
      `${code} still sends a signed-in person to sign in. Said: ${said}`)
  }
})

test('a damaged partition is not answered with sign-in advice', () => {
  /* putSetting forwards the account-data read's own code and reason for this
     one, and that file is deliberately left alone for the person to keep or
     discard -- which is the thing they need to hear. */
  const said = saveRefusalSentence({
    ok: false,
    code: 'ACCOUNT_DATA_DAMAGED',
    reason: 'The saved data for this account could not be read, and it has not been overwritten.',
  })
  assert.ok(said.includes('has not been overwritten'), `the damaged-partition reason was dropped. Said: ${said}`)
  assert.doesNotMatch(said, /Sign in/)
})

test('a refusal with no reason still says nothing changed, and does not invent one', () => {
  for (const answer of [null, undefined, { ok: false }, { ok: false, reason: '   ' }, { ok: false, reason: 7 }]) {
    const said = saveRefusalSentence(answer)
    assert.match(said, /^That change was not saved, so nothing on this computer changed\./)
    assert.match(said, /did not say why/, `a missing reason was papered over. Said: ${said}`)
    assert.doesNotMatch(said, /Sign in, then set it again/)
  }
})

test('the page asks for the sentence instead of holding its own copy', () => {
  const view = readFileSync(new URL('../../src/views/tools.js', import.meta.url), 'utf8')
  assert.ok(view.includes('saveRefusalSentence'), 'the tools page does not use the shared sentence')
  assert.ok(!view.includes('Sign in, then set it again'),
    'the discarded-reason sentence is still hard-coded in the page')
})
