// B6 — NO BARE IDENTIFIER IN FRONT OF A PERSON, AND EVERY REFUSAL SAYS WHAT TO DO.
//
// WHAT THIS SUITE IS FOR, AND WHAT IT IS NOT FOR. It holds the RULE. It cannot
// hold the product: a module can be perfect and a view can still print
// `result.code` next to it, which is exactly how the nine sites this repairs
// came to exist while src/agent-availability-copy.js was already correct. The
// product half is measured by driving real refusals in the packaged window --
// tools/refusal-copy-qa.mjs -- and neither suite substitutes for the other.
//
// Two properties are asserted here and they are not the same property:
//   1. nothing this module returns is a bare identifier, for ANY input,
//      including inputs nobody wrote a table entry for; and
//   2. everything it returns ends with something to do.
// (1) alone is satisfied by returning "Refused." forever, which is why (2) is
// separate and why the length floor exists.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAst } from 'rollup/parseAst'
import { canonicalRootForTests } from '../canonical-root.mjs'

import {
  GENERIC_REMEDY,
  IDENTIFIER_RE,
  REFUSAL_REMEDY,
  SUBSCRIPTION_COMING_SOON_REMEDY,
  isBareIdentifier,
  markRefusalCode,
  refusalCodeOf,
  refusalRemedy,
  refusalSentence,
} from '../../src/refusal-copy.js'
import { abandonedLaunchMessage } from '../../src/tree-launch-queue.js'
import { UNAVAILABLE_TEXT, unavailableReason } from '../../src/agent-availability-copy.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = relative => readFileSync(path.join(REPO, relative), 'utf8')

/* A sentence is not a sentence if a person cannot act on it. 40 characters is
   not a style rule -- it is the length below which none of the remedies in this
   product fit, so anything shorter is a placeholder somebody meant to replace. */
const MIN_SENTENCE = 40

function assertActionable(text, what) {
  assert.equal(typeof text, 'string', `${what} did not return a string`)
  assert.ok(text.trim().length >= MIN_SENTENCE, `${what} is too short to act on: ${JSON.stringify(text)}`)
  assert.ok(!isBareIdentifier(text), `${what} is a bare identifier: ${text}`)
  /* No identifier anywhere in it, not merely at the start. The first repair of
     this defect moved the code to the END of the line, which is the same line. */
  const embedded = text.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)
  assert.equal(embedded, null, `${what} carries the identifier ${embedded?.join(', ')} in visible text: ${text}`)
  assert.match(text, /[.!?…]$/, `${what} does not end as a sentence: ${text}`)
}

test('the identifier test recognises this product’s codes and not English', () => {
  for (const code of ['BRIDGE_UNREACHABLE', 'AGENT_TURN_NONE', 'MC_ACCOUNT_SIGNED_OUT', 'A_B_C1']) {
    assert.ok(IDENTIFIER_RE.test(code), `${code} should read as an identifier`)
  }
  for (const prose of [
    'Nothing was sent.',
    'BRIDGE unreachable',            // a space: prose, not a code
    'Bridge_Unreachable',            // mixed case: not this product's shape
    'ALLCAPS',                       // no underscore: a word, not a code
    '',
  ]) {
    assert.ok(!isBareIdentifier(prose), `${JSON.stringify(prose)} should not read as an identifier`)
  }
})

test('every curated remedy is a whole sentence with no identifier in it', () => {
  const entries = Object.entries(REFUSAL_REMEDY)
  for (const [code, remedy] of entries) {
    assert.ok(IDENTIFIER_RE.test(code), `${code} is not shaped like a code, so nothing will ever look it up`)
    assertActionable(remedy, `REFUSAL_REMEDY.${code}`)
    /* The whole point of the table is that it says what to DO. A remedy with no
       verb a person can follow is a diagnosis wearing a remedy's clothes. */
    assert.match(
      remedy,
      /\b(try|press|open|close|choose|pick|refresh|reload|check|look|correct|shorten|stop|start|wait|turn|reinstall|ask|sign|read|change)\b/i,
      `REFUSAL_REMEDY.${code} names no action a person can take: ${remedy}`,
    )
  }
})

test('subscription refusals state the delayed offer exactly and never promise plans', () => {
  const exact = 'Nothing was started and nothing was charged. Subscriptions are not open yet. The product is free meanwhile and does not need a subscription to run. Keep using everything that runs on this computer; it is unaffected.'
  assert.equal(SUBSCRIPTION_COMING_SOON_REMEDY, exact)
  for (const code of [
    'ENTITLEMENT_REQUIRED',
    'ENTITLEMENT_TIER_INSUFFICIENT',
    'ENTITLEMENT_EXPIRED',
    'ENTITLEMENT_INACTIVE',
    'ENTITLEMENT_REVOKED',
    'ENTITLEMENT_LICENSE_KEY_INVALID',
  ]) {
    assert.equal(REFUSAL_REMEDY[code], exact, `${code} still publishes a different subscription story`)
  }
  assert.equal(refusalRemedy('HOSTED_RELAY_ENTITLEMENT_FUTURE_CODE'), exact)
})

test('a code nobody wrote an entry for still leaves with a sentence', () => {
  /* THE PROPERTY THAT MAKES THE RULE HOLD OVER TIME. The engine's code
     vocabulary grows; a table alone fails open on the next addition. Each of
     these is deliberately absent from REFUSAL_REMEDY. */
  const unseen = [
    'BRIDGE_SOMETHING_INVENTED_NEXT_MONTH',
    'BRIDGE_TERMINATE_SOMETHING_NEW',
    'BRIDGE_CLOUD_SOMETHING_NEW',
    'ORG_SOMETHING_NEW',
    'MC_ACCOUNT_SOMETHING_NEW',
    'LOOP_SOMETHING_NEW',
    'TOTALLY_UNRELATED_THING',
  ]
  for (const code of unseen) {
    assert.ok(!Object.hasOwn(REFUSAL_REMEDY, code), `${code} was added to the table; pick another unseen code for this test`)
    assertActionable(refusalRemedy(code), `refusalRemedy(${code})`)
    assertActionable(refusalSentence({ ok: false, code }), `refusalSentence(${code})`)
  }
  /* Family membership is real, not incidental: a terminate code must not be
     answered with the generic remedy when a terminate remedy exists. */
  assert.notEqual(refusalRemedy('BRIDGE_TERMINATE_SOMETHING_NEW'), GENERIC_REMEDY)
  assert.match(refusalRemedy('BRIDGE_TERMINATE_SOMETHING_NEW'), /stop/i)
  assert.match(refusalRemedy('BRIDGE_CLOUD_SOMETHING_NEW'), /spent|launch/i)
  assert.equal(refusalRemedy('TOTALLY_UNRELATED_THING'), GENERIC_REMEDY)
})

/* EVERY REFUSAL THE LAUNCH RECORD CAN RAISE, READ OFF THE ENGINE ITSELF.
 *
 * A HAND-WRITTEN LIST WOULD MEASURE THIS SUITE'S MEMORY, NOT THE PRODUCT. The
 * codes are scanned out of the shipped payload, so an engine that adds one next
 * month is covered here the day it lands rather than the day somebody remembers.
 *
 * WHAT WAS TRUE BEFORE THIS EXISTED: exactly one of them was curated, and every
 * other one — over twenty codes, including "that agent is switched off" and
 * "that agent may not take this work" — fell through every family to the generic
 * remedy, which tells the reader to close the application and open it again.
 * They were unreachable while a fresh install declared no agents to launch; the
 * shipped organisation now declares eight, so they are live.
 */
test('no refusal from the launch record reaches a person as "close and reopen the app"', () => {
  const source = readFileSync(path.join(canonicalRootForTests(), 'src', 'lib', 'controller-launch-record.js'), 'utf8')
  const codes = new Set([...source.matchAll(/fail\('(LAUNCH_[A-Z0-9_]+)'/g)].map(match => match[1]))
  assert.ok(codes.size >= 15, `the scan found only ${codes.size} launch codes, so its pattern has stopped matching`)

  for (const code of codes) {
    const remedy = refusalRemedy(code)
    assertActionable(remedy, `refusalRemedy(${code})`)
    assert.notEqual(remedy, GENERIC_REMEDY, `${code} still falls to the generic remedy`)
    /* The specific wrong advice this repairs. None of these is cured by
       restarting, and a person who follows that instruction loses their window
       and comes back to the same refusal. */
    assert.ok(!/reopen|open it a second time|reinstall/i.test(remedy),
      `${code} tells a person to restart the application, which cannot clear it: ${remedy}`)
  }

  /* The five the brief named are curated rather than left on the family floor,
     because each has a DIFFERENT next move and the floor can only offer one. */
  for (const code of ['LAUNCH_DISABLED_AGENT', 'LAUNCH_UNKNOWN_AGENT', 'LAUNCH_PHASE_REJECTED', 'LAUNCH_SCOPE_ACTIVATION_REQUIRED', 'LAUNCH_FANOUT_EXCEEDED']) {
    assert.ok(Object.hasOwn(REFUSAL_REMEDY, code), `${code} has no curated sentence of its own`)
    assert.ok(codes.has(code), `${code} is curated but the engine no longer raises it; check the entry is still wanted`)
  }
})

test('an abandoned launch message keeps readable English and hides its hold code', () => {
  const code = 'AGENT_RESOURCE_PRESSURE'
  const input = { attempts: 6, code, kind: 'cpu' }
  const englishReason = 'The computer reported too little CPU headroom.'
  const withReason = abandonedLaunchMessage({ ...input, reason: englishReason })
  const withoutReason = abandonedLaunchMessage(input)
  const withCodeReason = abandonedLaunchMessage({ ...input, reason: code })
  const codePattern = new RegExp(`\\b${code}\\b`)

  for (const [name, shown] of [['English reason', withReason], ['no reason', withoutReason], ['code-shaped reason', withCodeReason]]) {
    assertActionable(shown, `abandonedLaunchMessage (${name})`)
    assert.match(shown, /\b(?:start|wait|stop|try|check|open)\b/i, `${name} has no action for the person`)
    assert.doesNotMatch(shown, codePattern, `${name} exposed the machine hold code: ${shown}`)
  }
  assert.match(withoutReason, /\brefused 6 times\b/i, 'the attempt count was not preserved')
  assert.match(withoutReason, /\bstart it again\b/i, 'the person was not told how to try again')
  assert.match(withoutReason, /\broom\b/i, 'the person was not told the resource condition')
  assert.ok(withReason.includes(englishReason), 'the monitor English was not preserved')
  assert.equal(withCodeReason, withoutReason, 'a code-shaped reason must be treated as absent prose')
})
/* THE ENGINE'S OWN ARCHIVE CODES reach this table unchanged (typedError keeps
   a well-formed code), and every one of them means the request was left where
   it was. The floor must say so, and must say the one thing a person can do
   about a row that will not archive -- hide it on the Ledger page. Without it
   these fell to GENERIC_REMEDY and "close ToolsEnabled and open it again". */
test('a request the archive will not take is answered with where it is and what to do instead, not with a restart', () => {
  for (const code of ['LEDGER_ARCHIVE_TARGET_INELIGIBLE', 'LEDGER_ARCHIVE_EXPOSURE_INSUFFICIENT', 'LEDGER_ARCHIVE_PROTECTED_REQUEST', 'LEDGER_ARCHIVE_VETOED']) {
    assert.ok(!Object.hasOwn(REFUSAL_REMEDY, code), `${code} was curated; this test measures the family floor`)
    const remedy = refusalRemedy(code)
    assert.notEqual(remedy, GENERIC_REMEDY, `${code} fell to the generic remedy`)
    assert.match(remedy, /^Nothing was moved\./)
    assert.match(remedy, /hide it from the Ledger page instead/)
    assertActionable(refusalSentence({ ok: false, code }), `refusalSentence(${code})`)
  }
})

test('a full pool is answered as capacity, not as something the person set up wrong', () => {
  /* BRIDGE_ALL_SEATS_BUSY is raised when every agent in the level's pool is
     already carrying a lane. Telling that reader to change what they chose sends
     them to edit their fleet over a queue that clears on its own, so this
     assertion is about what the sentence must NOT do as much as what it says. */
  const remedy = refusalRemedy('BRIDGE_ALL_SEATS_BUSY')
  assertActionable(remedy, 'refusalRemedy(BRIDGE_ALL_SEATS_BUSY)')
  assert.notEqual(remedy, GENERIC_REMEDY)
  assert.match(remedy, /\bwait\b/i, 'a capacity refusal has to offer waiting as an answer')
  assert.match(remedy, /\bstop\b/i, 'a capacity refusal has to offer stopping one as the other answer')
  assert.ok(!/reopen|reinstall|correct what you|not one this copy/i.test(remedy),
    `a full pool was reported as a fault to be fixed: ${remedy}`)
})

test('ABSENCE — every shape of "we were told nothing" still produces a whole sentence', () => {
  /* THE SIGNATURE DEFECT OF THIS CODEBASE, in its refusal-copy costume. Each of
     these really arrives: a call that threw before the layer said anything, a
     receipt-shaped object with no fields, `reason: error?.message` where the
     message is empty, and -- the one that would have put the identifier back on
     the glass through the one door left open -- a reason that IS a code. */
  const absences = [
    undefined,
    null,
    {},
    { ok: false },
    { ok: false, code: '' },
    { ok: false, code: null },
    { ok: false, reason: '' },
    { ok: false, reason: '   ' },
    { ok: false, code: 'BRIDGE_UNREACHABLE', reason: '' },
    { ok: false, code: 'BRIDGE_UNREACHABLE', reason: 'BRIDGE_UNREACHABLE' },
    { ok: false, reason: 'ERR_IPC_CHANNEL_CLOSED' },
    { ok: false, code: 42, reason: 7 },
    { ok: false, code: 'not a code at all', reason: null },
    'a string where an object was expected',
    0,
  ]
  for (const absence of absences) {
    assertActionable(refusalSentence(absence), `refusalSentence(${JSON.stringify(absence)})`)
  }
})

test('a reason that is itself an identifier is never shown as prose', () => {
  const shown = refusalSentence({ ok: false, code: 'BRIDGE_TIMEOUT', reason: 'BRIDGE_TIMEOUT' })
  assert.ok(!shown.includes('BRIDGE_TIMEOUT'), `the identifier reached visible text through the reason field: ${shown}`)
  assert.equal(shown, refusalSentence({ ok: false, code: 'BRIDGE_TIMEOUT' }),
    'a reason that is only a restatement of the code should read the same as no reason at all')
})

test('the engine’s English survives verbatim, with the remedy after it', () => {
  const engine = 'The initiating actor is not the enabled declared controller.'
  const shown = refusalSentence({ ok: false, code: 'BRIDGE_ACTOR_REFUSED', reason: engine })
  assert.ok(shown.startsWith(engine), `the engine's own sentence was dropped or reworded: ${shown}`)
  assert.ok(shown.length > engine.length, 'the diagnosis was shown with no remedy after it')
  assert.ok(shown.endsWith(REFUSAL_REMEDY.BRIDGE_ACTOR_REFUSED), `the remedy is not the one the table names: ${shown}`)
})

test('a diagnosis with no full stop still reads as a sentence, and one with a full stop gets no second one', () => {
  const bare = refusalSentence({ ok: false, code: 'BRIDGE_TIMEOUT', reason: 'the request never came back' })
  assert.match(bare, /came back\. /, `punctuation was not repaired: ${bare}`)
  const stopped = refusalSentence({ ok: false, code: 'BRIDGE_TIMEOUT', reason: 'The request never came back.' })
  assert.ok(!stopped.includes('..'), `a second full stop was added: ${stopped}`)
})

test('a caller’s fallback fills the diagnosis slot, and a caller’s remedy overrides the table', () => {
  const withFallback = refusalSentence({ ok: false, code: 'BRIDGE_REQUEST_FAILED' }, { fallback: 'The dispatch was refused with no receipt.' })
  assert.match(withFallback, /^The dispatch was refused with no receipt\./)
  const overridden = refusalSentence({ ok: false, code: 'BRIDGE_REQUEST_FAILED' }, { remedy: 'Refresh the task list before pressing Launch again.' })
  assert.ok(overridden.endsWith('Refresh the task list before pressing Launch again.'), overridden)
  assert.ok(!overridden.includes(REFUSAL_REMEDY.BRIDGE_REQUEST_FAILED), 'the override did not replace the table entry')
  /* An empty override is an ABSENCE, not an instruction to say nothing. */
  const emptyOverride = refusalSentence({ ok: false, code: 'BRIDGE_REQUEST_FAILED' }, { remedy: '   ' })
  assert.equal(emptyOverride, refusalSentence({ ok: false, code: 'BRIDGE_REQUEST_FAILED' }))
})

test('refusalCodeOf reports the code only when there is one', () => {
  assert.equal(refusalCodeOf({ code: 'BRIDGE_TIMEOUT' }), 'BRIDGE_TIMEOUT')
  assert.equal(refusalCodeOf({ code: '  BRIDGE_TIMEOUT  ' }), 'BRIDGE_TIMEOUT')
  for (const nothing of [undefined, null, {}, { code: '' }, { code: '   ' }, { code: 12 }, { code: 'a sentence, not a code' }, 'string']) {
    assert.equal(refusalCodeOf(nothing), null, `refusalCodeOf(${JSON.stringify(nothing)}) invented a code`)
  }
})

test('markRefusalCode writes the identifier to the DOM and never writes an empty one', () => {
  /* A hand-rolled stand-in rather than jsdom: this repo's suites run under plain
     node, and the contract being checked is three method calls wide. */
  const node = {
    attributes: new Map(),
    setAttribute(name, value) { this.attributes.set(name, value) },
    removeAttribute(name) { this.attributes.delete(name) },
  }
  markRefusalCode(node, { code: 'BRIDGE_TIMEOUT' })
  assert.equal(node.attributes.get('data-refusal-code'), 'BRIDGE_TIMEOUT')
  /* The absence case: a later success must REMOVE it, not blank it. A blank
     attribute reads as "there is a code and it is empty" to every probe that
     tests for presence, which is this codebase's signature defect exactly. */
  markRefusalCode(node, null)
  assert.equal(node.attributes.has('data-refusal-code'), false, 'an absent code left a blank attribute behind')
  assert.doesNotThrow(() => markRefusalCode(null, { code: 'BRIDGE_TIMEOUT' }))
  assert.doesNotThrow(() => markRefusalCode({}, { code: 'BRIDGE_TIMEOUT' }))
})

test('the agent-start table’s unknown-code door is closed too', () => {
  /* unavailableReason() used to return `String(code)` for anything it had no
     entry for, which is the same defect inside the module that fixed it
     everywhere else. src/agent-session.js reaches it with `error?.code` from a
     rejected IPC call, and a platform rejection carries codes like this one. */
  for (const code of ['ERR_IPC_CHANNEL_CLOSED', 'AGENT_SOMETHING_NEW', 'MADE_UP_CODE']) {
    const shown = unavailableReason(code)
    assert.ok(!shown.includes(code), `unavailableReason still prints the bare code for ${code}: ${shown}`)
    assert.ok(shown.trim().length >= MIN_SENTENCE, `unavailableReason(${code}) is too short to act on: ${shown}`)
  }
  for (const nothing of [undefined, null, '', 0]) {
    const shown = unavailableReason(nothing)
    assert.ok(shown.trim().length >= MIN_SENTENCE, `unavailableReason(${JSON.stringify(nothing)}) says nothing useful: ${shown}`)
  }
  /* A code it DOES know must still get its own sentence, unchanged. */
  assert.equal(unavailableReason('AGENT_TURN_NONE'), UNAVAILABLE_TEXT.AGENT_TURN_NONE)
})

test('a pending session switch tells the person to wait and retry, not that it was an unknown fault', () => {
  const shown = unavailableReason('AGENT_SWITCH_PENDING')
  assert.equal(typeof shown, 'string')
  assert.ok(shown.trim().length >= MIN_SENTENCE, `AGENT_SWITCH_PENDING is too short to guide a person: ${shown}`)
  assert.match(shown, /\b(?:session|switch|replacement|change)\b/i, 'the pending session change was not identified')
  assert.match(shown, /\bwait(?:ing)?\b/i, 'the pending session change did not tell the person to wait')
  assert.match(shown, /(?:\bretry\b|\btry\b[^.!?]*\bagain\b)/i, 'the pending session change did not tell the person how to retry')
  assert.doesNotMatch(shown, /could not work out why|fault worth reporting|not told why/i,
    `AGENT_SWITCH_PENDING fell through to generic fault advice: ${shown}`)
  assert.notEqual(shown, unavailableReason('SOMETHING_NOBODY_WROTE'),
    'AGENT_SWITCH_PENDING must not share the unknown-code fallback')
})
test('the three session-steering codes the agent page renders all have sentences', () => {
  /* src/views/agent.js prints `${id} did not happen · ${result?.code}` for the
     Pause / Respawn / Terminate controls. These are the codes those three can
     answer with, read off src/agent-session.js's control object. */
  const source = read('src/agent-session.js')
  const control = source.slice(source.indexOf('control = Object.freeze({'))
  const raised = new Set([...control.matchAll(/code:\s*'([A-Z][A-Z0-9_]+)'/g)].map(match => match[1]))
  assert.ok(raised.size >= 4, `the scan found only ${raised.size} steering codes, so its pattern has stopped matching`)
  for (const code of raised) {
    assert.ok(Object.hasOwn(UNAVAILABLE_TEXT, code), `the steering controls can answer ${code} and no surface has a sentence for it`)
  }
})

/* COMMENTS ARE NOT CODE, and a scan that forgets it measures the wrong thing.
 *
 * Every note in this lane's diff quotes the line it replaced -- that is how the
 * repair explains itself -- so a naive text scan for `${...code...}` finds
 * sixteen hits and every one of them is prose. Team 2's B2 hit the same trap
 * from the other side and reported a count that was two too high. So the scan
 * blanks comments before it looks, character by character rather than by
 * regex: a `//` inside a string, and a `/*` inside a template literal, are both
 * real in this repo and neither starts a comment.
 *
 * REGULAR-EXPRESSION LITERALS ARE THE THIRD STATE, and leaving them out is what
 * broke the first version of this. src/org-controls.js opens with
 * `.replace(/[&<>"']/g, ...)`; a scanner that does not know that is a regex
 * sees the `"` inside it, believes a string has opened, and every comment for
 * the rest of the file looks like string content. A `/` starts a regex only
 * where a value cannot already have ended, which is what the operator test
 * below is: after `(`, `,`, `=`, `:`, `[`, `!`, `&`, `|`, `?`, `{`, `}`, `;`
 * or a return/typeof-style keyword, a `/` is a regex; after an identifier, a
 * `)` or a `]`, it is division.
 *
 * Line structure is preserved (comment characters become spaces) so the line
 * numbers it reports are the line numbers in the file.
 */
function withoutComments(source) {
  let out = ''
  let index = 0
  let quote = null          // ' " or ` while inside a string
  let comment = null        // 'line' or 'block'
  let regex = false         // inside a /regex/ literal
  const regexMayStart = () => {
    let end = out.length
    while (end > 0 && /\s/.test(out[end - 1])) end -= 1
    if (end === 0) return true
    if (/[([{,;:=!&|?+\-*%~^<>]/.test(out[end - 1])) return true
    const word = out.slice(0, end).match(/[A-Za-z]+$/)?.[0]
    return /^(return|typeof|case|in|of|do|else|instanceof|new|delete|void|throw)$/.test(word ?? '')
  }
  while (index < source.length) {
    const character = source[index]
    const next = source[index + 1]
    if (regex) {
      out += character
      if (character === '\\') { out += source[index + 1] ?? ''; index += 2; continue }
      if (character === '[') {
        // a character class: a `/` inside it is literal, so run to its close
        while (index + 1 < source.length && source[index + 1] !== ']') {
          index += 1
          out += source[index]
          if (source[index] === '\\') { index += 1; out += source[index] ?? '' }
        }
        index += 1
        out += source[index] ?? ''
        index += 1
        continue
      }
      if (character === '/' || character === '\n') regex = false
      index += 1
      continue
    }
    if (comment === 'line') {
      if (character === '\n') { comment = null; out += character } else out += ' '
      index += 1
      continue
    }
    if (comment === 'block') {
      if (character === '*' && next === '/') { comment = null; out += '  '; index += 2; continue }
      out += character === '\n' ? '\n' : ' '
      index += 1
      continue
    }
    if (quote) {
      out += character
      if (character === '\\') { out += source[index + 1] ?? ''; index += 2; continue }
      if (character === quote) quote = null
      index += 1
      continue
    }
    if (character === '/' && next === '/') { comment = 'line'; out += '  '; index += 2; continue }
    if (character === '/' && next === '*') { comment = 'block'; out += '  '; index += 2; continue }
    if (character === '/' && regexMayStart()) { regex = true; out += character; index += 1; continue }
    if (character === '\'' || character === '"' || character === '`') { quote = character; out += character; index += 1; continue }
    out += character
    index += 1
  }
  return out
}

test('the comment stripper does not blind the scan it feeds', () => {
  /* Without this, a stripper that returned '' would make the scan below pass
     forever while measuring nothing -- the shape of failure this whole lane is
     about. */
  const stripped = withoutComments([
    'const a = 1 // ${result.code}',
    '/* ${result.code} */',
    'const b = `kept ${result.code}`',
    'const c = "// not a comment"',
    'const d = value.replace(/[&<>"\']/g, x => x)',
    '/* after a regex containing quotes, this comment must still be blanked: ${result.code} */',
    'const e = total / count / 2',
    'const f = `still kept ${result.code}`',
  ].join('\n')).split('\n')
  assert.match(stripped[0], /const a = 1/)
  assert.ok(!stripped[0].includes('result.code'), 'a line comment survived')
  assert.ok(!stripped[1].includes('result.code'), 'a block comment survived')
  assert.match(stripped[2], /kept \$\{result\.code\}/, 'a template literal was blanked')
  assert.match(stripped[3], /\/\/ not a comment/, 'a string containing // was treated as a comment')
  assert.match(stripped[4], /\[&<>"'\]/, 'a regex literal was mangled')
  assert.ok(!stripped[5].includes('result.code'), 'a regex literal containing quotes blinded the scanner to later comments')
  assert.match(stripped[6], /total \/ count \/ 2/, 'division was mistaken for a regex')
  assert.match(stripped[7], /still kept \$\{result\.code\}/, 'code after a division was blanked')
  assert.equal(stripped.length, 8, 'line numbering was not preserved')
})

/* THE SOURCE SCAN, which is the one check that would have caught this whole
   defect class before a customer did.
 *
 * It is a text scan, and text scans are the weaker instrument -- everything
 * above asserts behaviour instead. But the defect being prevented IS textual:
 * somebody reaching for `${result.code}` in a new view, which no behavioural
 * test of an existing module can see. The scan is narrow on purpose: it looks
 * only for a code interpolated into a template literal, and it lists the files
 * it could not clear rather than counting them. */
function interpolatedCodeLines(source) {
  const lines = withoutComments(source).split('\n'), found = new Set()
  const translated = new Set(['unavailableReason', 'refusalRemedy', 'refusalSentence', 'readerSafeReason'])
  function carriesCode(node) {
    if (!node || typeof node !== 'object') return false
    if (node.type === 'Identifier') return node.name === 'code'
    if (node.type === 'Literal' || node.type === 'TemplateElement') return false
    if (node.type === 'CallExpression' && translated.has(node.callee?.name)) return false
    return Object.values(node).some(value => Array.isArray(value)
      ? value.some(carriesCode) : carriesCode(value))
  }
  function visit(node) {
    if (!node || typeof node !== 'object') return
    if (node.type === 'TemplateLiteral') for (const expression of node.expressions) {
      if (!carriesCode(expression)) continue
      const index = source.slice(0, expression.start).split('\n').length - 1
      if (!/data-[a-z-]*code/.test(lines[index])) found.add(index)
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object') visit(value)
    }
  }
  visit(parseAst(source))
  return [...found].sort((a, b) => a - b).map(index => ({ index, line: lines[index] }))
}

test('the refusal scan distinguishes nested markup from interpolated identifiers', () => {
  assert.deepEqual(interpolatedCodeLines('const html = `${address ? `<code>${escape(address)}</code>` : ""}`'), [])
  assert.equal(interpolatedCodeLines('const html = `${address ? `<code>${result.code}</code>` : ""}`').length, 1)
  assert.equal(interpolatedCodeLines('const html = `Failed: ${result?.code}`').length, 1)
  assert.deepEqual(interpolatedCodeLines('const html = `${refusalSentence(result.code)}`'), [])
  assert.equal(interpolatedCodeLines('const html = `${refusalSentence(result.code) + result.code}`').length, 1)
})

test('no view or copy module interpolates a code into a string a person reads', () => {
  const roots = ['src', path.join('src', 'views')]
  const files = []
  for (const root of roots) {
    for (const entry of readdirSync(path.join(REPO, root), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.js')) files.push(path.join(root, entry.name).split(path.sep).join('/'))
    }
  }
  assert.ok(files.length >= 40, `the scan found only ${files.length} modules, so its walk has stopped matching`)

  /* THE FENCE IS EMPTY, AND THAT IS THE POINT IT WAS LEFT HERE TO REACH.
   *
   * It used to hold src/views/agent.js, whose steering controls printed
   * `${id} did not happen · ${result?.code}` -- the last bare identifier in the
   * product -- with the note that the entry should be deleted when the edit
   * landed. The edit has landed: that line now composes the control's own words
   * with unavailableReason(), and the code stays on `result.code` where a
   * support conversation can still reach it.
   *
   * The set stays, and so does the assertion below that a fenced file is really
   * still offending, so that fencing the NEXT one is a two-line act somebody has
   * to write down rather than a quiet skip.
   *
   * src/research-benchmark.js is fenced on purpose, for one row. The Research
   * readiness panel (readinessPurposeSection) prints each blocker's requirement
   * code beside its exact path, the engine's message and a plain-language next
   * step. There the code is the study requirement's identifier, a machine
   * locator a researcher looks up, and research-benchmark-page-execution-path
   * requires it to be visible. It is never the only thing a person reads. */
  const fenced = new Set(['src/research-benchmark.js'])

  const offences = []
  for (const file of files) {
    for (const { line, index } of interpolatedCodeLines(read(file))) {
      offences.push(`${file}:${index + 1}: ${line.trim()}`)
    }
  }
  const unexpected = offences.filter(offence => ![...fenced].some(name => offence.startsWith(`${name}:`)))
  assert.deepEqual(unexpected, [], `these lines put a code into a string a person reads:\n${unexpected.join('\n')}`)

  /* A fence that no longer covers a real offence is a permanent exemption
     wearing a temporary one's clothes, so an empty fence is fine and a stale
     entry is not. */
  for (const name of fenced) {
    assert.ok(
      offences.some(offence => offence.startsWith(`${name}:`)),
      `${name} no longer interpolates a code, so remove it from the fenced list above rather than leaving a permanent exemption`,
    )
  }
})

/* A node keeps the sentence it was refused with, written for the desk. A
 * browser reading that computer over the relay cannot "close the whole app";
 * it gets the remote reading of the same failure. Measured on the live site
 * on 2026-08-22. */
test('a stored desk remedy is re-read for a browser driving the computer', async () => {
  const { readerRemedy, REFUSAL_REMEDY } = await import('../../src/refusal-copy.js')
  const desk = REFUSAL_REMEDY.BRIDGE_UNREACHABLE
  assert.match(desk, /close the whole app/)
  assert.equal(readerRemedy(desk), desk, 'at the desk the sentence stands')
  const remote = readerRemedy(desk, { viaRelay: true })
  assert.notEqual(remote, desk)
  assert.doesNotMatch(remote, /this window/, 'the remote reading must not speak of a window the reader is not at')
  assert.match(remote, /On that computer/)
  assert.equal(readerRemedy('Something else entirely.', { viaRelay: true }), 'Something else entirely.', 'only the desk sentence is re-read')
})

test('a rules-reader refusal keeps its diagnosis and names the repair computer in raw and composed relay messages', async () => {
  const { readerRemedy } = await import('../../src/refusal-copy.js')
  const { readAgentEngine } = await import('../../src/local-activity.js')
  const { startRefusalSentence } = await import('../../src/fleet-tree-copy.js')
  const code = 'RULES_POLICY_UNAVAILABLE'
  const home = readAgentEngine({ ok: false, code })
  assert.equal(home.ready, false)
  const rawRemote = 'ToolsEnabled could not load the rules needed for this agent. On that computer, reinstall or update ToolsEnabled from a complete build, then try again from here'
  const forms = [
    ['home fact', home.why, rawRemote],
    ['shared remedy', refusalRemedy(code), rawRemote + '.'],
    ['raw availability', unavailableReason(code), rawRemote + '.'],
    ['shared refusal', refusalSentence({ ok: false, code }), rawRemote + '.'],
    ['tree start', startRefusalSentence({ ok: false, code }), 'Nothing was started. ' + rawRemote + '.'],
  ]
  for (const [name, desk, remote] of forms) {
    assert.equal(readerRemedy(desk), desk, name + ' must keep its desktop wording')
    assert.equal(readerRemedy(desk, { viaRelay: false }), desk, name)
    assert.equal(readerRemedy(desk, { viaRelay: true }), remote, name)
    assert.equal(readerRemedy(remote, { viaRelay: true }), remote, name + ' must remain stable when read again')
    assert.doesNotMatch(remote, /RULES_|reset.*data/i, name)
  }
  for (const adjacent of ['RULES_CONTEXT_UNAVAILABLE', 'RULES_POLICY_CHANGED']) {
    const sentence = refusalRemedy(adjacent)
    assert.equal(readerRemedy(sentence, { viaRelay: true }), sentence, adjacent + ' uses controls available from either reader')
  }
})

test('an already-finished stop names the driven computer for a relay reader', async () => {
  const { readerRemedy, REFUSAL_REMEDY } = await import('../../src/refusal-copy.js')
  const desk = 'There was nothing left to stop — it had already finished. Nothing on this computer is still running from it.'
  const remote = 'There was nothing left to stop — it had already finished. Nothing on that computer is still running from it.'

  assert.equal(REFUSAL_REMEDY.BRIDGE_TERMINATE_ALREADY_TERMINAL, desk)
  assert.equal(readerRemedy(desk), desk, 'the local reader keeps the desk wording byte-for-byte')
  assert.equal(readerRemedy(desk, { viaRelay: true }), remote, 'the relay reader is told about the driven computer')
})

/* The sign-in refusal told a browser reader to "open a new terminal window and
 * run codex login" on a computer they were not at (measured 2026-08-23 driving
 * a fresh one-computer account). Over the relay the advice is re-read; the
 * fact -- no sign-in on that computer -- stands. */
test('a sign-in refusal read over the relay points at that computer, not this window', async () => {
  const { readerRemedy } = await import('../../src/refusal-copy.js')
  const desk = 'Nothing was started. This session needs a Codex sign-in, and this computer does not hold one. The permission level recorded here builds each session from that sign-in. If Codex is installed, open a new terminal window and run "codex login". If it is not, run "winget install OpenAI.Codex" first. Then come back to this screen.'
  assert.equal(readerRemedy(desk), desk)
  const remote = readerRemedy(desk, { viaRelay: true })
  assert.notEqual(remote, desk)
  assert.match(remote, /On that computer, open a terminal and run "codex login"/)
  assert.match(remote, /that computer does not hold one/)
  assert.doesNotMatch(remote, /open a new terminal window/)
  assert.doesNotMatch(remote, /come back to this screen/)
  assert.match(remote, /try again from here/)
})

/* THE ANSWER TO "IS MY AGENT AVAILABLE?" OVER A DEAD RELAY. The three codes the
 * host bridge throws when the leg is gone had no entry in UNAVAILABLE_TEXT, so
 * the reason fell through to "this copy could not work out why, which is itself
 * a fault worth reporting" plus the desk remedy — a shrug and an instruction the
 * remote reader cannot follow, about a state the product understands perfectly
 * well. Found by the relay-path review, 2026-08-23. */
test('a dead relay leg has a reason of its own, not a shrug', async () => {
  const { unavailableReason, UNAVAILABLE_TEXT } = await import('../../src/agent-availability-copy.js')
  for (const code of ['BRIDGE_UNREACHABLE', 'BRIDGE_TIMEOUT', 'BRIDGE_FORBIDDEN_ON_PUBLIC_ORIGIN']) {
    assert.ok(Object.prototype.hasOwnProperty.call(UNAVAILABLE_TEXT, code), `${code} has no sentence`)
    const said = unavailableReason(code)
    assert.doesNotMatch(said, /could not work out why/, `${code} still answers with a shrug`)
    assert.doesNotMatch(said, /close the whole app|reinstall/i, `${code} still carries desk advice`)
    assert.ok(said.length > 20 && said === said.toLowerCase().slice(0, 1) + said.slice(1), `${code} reads oddly: ${said}`)
  }
  /* The fallthrough itself stays: a code nobody wrote copy for must still leave
     with a sentence rather than an identifier. */
  assert.match(unavailableReason('SOMETHING_NOBODY_WROTE'), /could not work out why/)
})
