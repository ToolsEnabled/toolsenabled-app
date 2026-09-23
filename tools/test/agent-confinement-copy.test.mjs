/* The pure copy boundary used by both Start controls. These tests exercise the
 * readings those callers receive rather than pinning prose byte-for-byte: the
 * user-facing contract is which facts and refusals are disclosed. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TIER_CHOICES } from '../../src/setup-state.js'

import {
  CONFINEMENT_SUBJECT_REMOTE,
  confinementLine,
  confinementNote,
  startControlLine,
  toolsSentence,
} from '../../src/agent-confinement-copy.js'

const readings = [
  { tier: 'guided', sandbox: 'read-only', allowed: 109 },
  { tier: 'standard', sandbox: 'workspace-write', allowed: 256 },
  { tier: 'unrestricted', sandbox: 'danger-full-access', allowed: null },
]

test('measured tool counts are described without inventing unusable counts', () => {
  const narrowed = toolsSentence({ allowed: 109, total: 265 })
  assert.match(narrowed, /\b109\b.*\b265\b/,
    'a narrowed reading must disclose both the offered and total tool counts')

  const unrestricted = toolsSentence({ allowed: null, total: 265 })
  assert.match(unrestricted, /\ball\b.*\b265\b/i,
    'an unrestricted reading must say the whole measured surface is offered')

  for (const unusable of [
    undefined,
    {},
    { allowed: 2, total: 0 },
    { allowed: -1, total: 10 },
    { allowed: 11, total: 10 },
    { allowed: 1.5, total: 10 },
  ]) {
    assert.equal(toolsSentence(unusable), null,
      'an absent, impossible, or non-integral measurement must not become a tool-count claim')
  }
})

test('real caller readings disclose the requested policy, credentials, tools, and recording', () => {
  for (const reading of readings) {
    const note = confinementNote({
      ok: true,
      tier: reading.tier,
      sandbox: reading.sandbox,
      failedClosed: false,
      toolsAllowed: reading.allowed,
      toolsTotal: 265,
    })
    const copy = note.sentences.join(' ')

    assert.match(note.level, new RegExp(reading.tier, 'i'),
      `${reading.tier} must name the level that will govern Start`)
    assert.match(note.effect, /\b(read(?:ing)?|chang(?:e|ing)|files?|folders?)\b/i,
      `${reading.tier} must disclose its effect on the user's files`)
    assert.match(copy, /credential/i,
      `${reading.tier} must disclose whether and how credentials can be requested`)
    assert.match(copy, /recorded/i,
      `${reading.tier} must disclose that Start is recorded before execution`)
    assert.ok(Object.isFrozen(note) && Object.isFrozen(note.sentences),
      `${reading.tier} copy must be immutable after it is composed`)
    assert.equal(note.sentences.at(-1), note.record,
      `${reading.tier} must leave the recording disclosure in the rendered sentence list`)
    assert.ok(note.tools && copy.includes(note.tools),
      `${reading.tier} must render its valid measured tool disclosure`)
  }

  const guided = confinementNote({ ok: true, tier: 'guided', sandbox: 'read-only' })
  assert.match(guided.sentences.join(' '), /cannot ask.*credentials/i,
    'Guided must disclose the credential-request refusal before the user presses Start')
  const standard = confinementNote({ ok: true, tier: 'standard', sandbox: 'workspace-write' })
  assert.match(standard.effect, /Writes elsewhere are outside that policy/,
    'Standard must state the requested write boundary without claiming all outside access is refused')
  const open = confinementNote({ ok: true, tier: 'unrestricted', sandbox: 'danger-full-access' })
  assert.match(open.sentences.join(' '), /without asking/i,
    'Unrestricted must disclose that file and program access is not narrowed by prompts')
})

test('could-not-read and unfamiliar readings stay unknown rather than becoming definite answers', () => {
  const unreadable = [undefined, null, false, [], {}, { ok: false }, new Error('offline')]
  for (const reading of unreadable) {
    const note = confinementNote(reading)
    assert.equal(note.level, null,
      'a could-not-read result must not claim that a definite level is active')
    assert.match(note.effect, /cannot tell|not going to guess/i,
      'a could-not-read result must explicitly refuse to guess')
    assert.equal(note.sentences.includes(note.effect), true,
      'the refusal to guess must be present in the rendered sentences')
  }

  const unfamiliar = confinementNote({
    ok: true,
    tier: 'standard',
    sandbox: 'future-sandbox',
    failedClosed: true,
  })
  assert.equal(unfamiliar.level, null,
    'an unfamiliar sandbox must not retain a reassuring definite level')
  assert.match(unfamiliar.effect, /cannot tell|not going to guess/i,
    'an unfamiliar sandbox must explicitly refuse to guess')
  assert.ok(unfamiliar.note && unfamiliar.sentences.includes(unfamiliar.note),
    'a failed-closed reading must disclose that the restrictive default is in force')
})

test('the full and compact composers preserve safety facts for their real surfaces', () => {
  const reading = {
    ok: true,
    tier: 'standard',
    sandbox: 'workspace-write',
    failedClosed: true,
    toolsAllowed: 256,
    toolsTotal: 265,
  }
  const note = confinementNote(reading)
  const full = confinementLine(reading)
  const compact = startControlLine(reading)

  assert.equal(full, note.sentences.join(' '),
    'the full line must render exactly the module-selected sentence list')
  for (const fact of [note.level, note.effect, note.note]) {
    assert.ok(fact && compact.includes(fact),
      'the compact Start disclosure must retain level, file effect, and fail-closed warning')
  }
  assert.ok(!compact.includes(note.record) && !compact.includes(note.tools),
    'the compact surface must omit lower-priority recording and tool-count details')

  const remote = startControlLine(reading, { subject: CONFINEMENT_SUBJECT_REMOTE })
  assert.match(remote, /^The computer you are driving\b/,
    'the relay Start disclosure must name the computer being driven')
  assert.match(remote, /Writes elsewhere are outside that policy/,
    'the relay Start disclosure must preserve the requested write boundary')
})

test('desktop and remote full and compact disclosures distinguish requested writes from possible outside reads', () => {
  for (const subject of [undefined, CONFINEMENT_SUBJECT_REMOTE]) {
    for (const [tier, sandbox] of [['guided', 'read-only'], ['standard', 'workspace-write'], ['standard', 'read-only']]) {
      const reading = { ok: true, tier, sandbox }
      const note = confinementNote(reading, { subject })
      const full = note.sentences.join(' ')
      const compact = startControlLine(reading, { subject })
      for (const text of [full, compact]) {
        assert.match(text, /requested policy|requests writes/)
        assert.match(text, /outside.*(?:readable|reads may still be possible)/i)
        assert.match(text, /running session’s reported permissions/)
        assert.doesNotMatch(text, /cannot reach|anything outside.*refused|everything outside.*off limits|computer refuses any attempt/i)
      }
      if (sandbox === 'read-only') {
        assert.match(note.effect, /without changing them/)
        assert.doesNotMatch(note.effect, /requests writes/)
      } else {
        assert.match(note.effect, /temporary folders the program allows/)
        assert.match(note.effect, /can be more restrictive/)
      }
      const detail = TIER_CHOICES.find(choice => choice.tier === tier).detail
      assert.ok(full.includes(subject === CONFINEMENT_SUBJECT_REMOTE
        ? detail.replaceAll('this computer', 'the computer you are driving') : detail))
      if (subject === CONFINEMENT_SUBJECT_REMOTE) assert.doesNotMatch(full, /this computer/)
    }
  }
})
