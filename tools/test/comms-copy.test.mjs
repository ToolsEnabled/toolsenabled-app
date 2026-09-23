/* The words the Messages page shows, measured as words.
 *
 * These are the first tests of any rendered sentence on that page: before
 * src/comms-copy.js existed every sentence was composed inside closures in a
 * view that imports a stylesheet, so nothing could load it in node and nothing
 * covered the rail, the board, the segs or a single notice. What is pinned
 * here is what the owner filed: one fact said once (the inventory), plurals
 * spelled right for 0/1/2, no jargon from the plain-language gate's list, every
 * refusal at most 25 words a sentence with a next step in it, and the row
 * model that turns a report message into what a person sees.
 *
 * Run: node --test tools/test/comms-copy.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  COMMS_NAME, MODE_LABELS, RAIL_GROUPS, NO_SERVICES,
  LOADING_LINE, UNREADABLE_SUB, READ_STATE_WORDS, readStateWord, EXAMPLE_BADGE,
  inventoryLine, describe, serviceLine, emptyLine, boardEmptyLine,
  READER_REFUSALS, LOAD_FAILED,
  FOLD_CHARS, shouldFold, foldSummary,
  SENDER_HUES, senderHues, rowModel, KINDS, NO_ANSWER_YET,
  dayLabel, sameDay,
  NOT_RECORDED_HERE,
} from '../../src/comms-copy.js'
import { commsQuietNotice, hostAbsentNotice } from '../../src/first-run-needs.js'
import { IDENTIFIER_RE } from '../../src/refusal-copy.js'
import { ROLE_COLOR_THEMES, colorContrast, applyRoleColors } from '../../src/role-colors.js'
import { sentencesOf, wordsOf } from '../lib/user-visible-strings.mjs'

/* The names the page was cleared of, and the gate's jargon it must not use. */
const BANNED = [/message board/i, /watch board/i, /ops projection/i, /\bprojection\b/i, /\benvelope\b/i, /\bpayload\b/i, /\brenderer\b/i, /seen running/i, /\bMCP\b/]
/* The four nouns the old header used for one count; the inventory line may use none of them. */
const COUNT_NOUNS = [/\bon record\b/i, /\bdeclared\b/i, /separate records/i]
/* The action vocabulary tools/check-plain-language.mjs holds a failure to. */
const ACTION_VERB = /\b(try|press|open|close|choose|pick|refresh|reload|check|look|correct|shorten|stop|start|wait|turn|reinstall|ask|sign|read|change|run|install|move|use|add|remove|answer|come back|go|let|allow|permit|see|show|update|restart)\b/i

const report = ({ services = 2, channels = 3, messages = 5, live = 2, dead = 1, channelsOk = true, messagesOk = true, mcpOk = true, mcpReason = 'no', channelsReason = 'no', servicesRead = true } = {}) => ({
  declaredServices: !servicesRead ? null : Array.from({ length: services }, (unused, i) => ({ id: `s${i}`, displayName: `service ${i}`, transport: 'relay', port: 61411 + i })),
  channels: channelsOk
    ? { ok: true, reason: null, observedAt: null, value: Array.from({ length: channels }, (unused, i) => ({ id: `c${i}`, name: `c${i}`, state: 'healthy' })) }
    : { ok: false, reason: channelsReason, observedAt: null, value: null },
  mcp: mcpOk
    ? { ok: true, reason: null, observedAt: null, value: { live: Array.from({ length: live }, (unused, i) => `l${i}`), dead: Array.from({ length: dead }, (unused, i) => `d${i}`) } }
    : { ok: false, reason: mcpReason, observedAt: null, value: null },
  messages: messagesOk
    ? { ok: true, reason: null, observedAt: null, value: Array.from({ length: messages }, (unused, i) => ({ id: `m${i}`, channelId: 'c0', sender: 'a', at: '2026-08-20T12:00:00.000Z', text: 'x' })) }
    : { ok: false, reason: 'no', observedAt: null, value: null },
})

test('the page has one name and the mode switch names the faces, not the page', () => {
  // The navigation rail's name for the page (T1242): one name, not "comms" or "Agent comms".
  assert.equal(COMMS_NAME, 'Messages')
  const rail = readFileSync(new URL('../../index.html', import.meta.url), 'utf8').match(/<a\b[^>]*\bdata-route="comms"[^>]*>([^<]*)<\/a>/)
  assert.equal(rail?.[1].trim(), COMMS_NAME, 'the navigation rail and the page must say the same name')
  assert.deepEqual(MODE_LABELS, { watch: 'Board', channels: 'Channels' })
  assert.deepEqual(RAIL_GROUPS, { services: 'Services', channels: 'Channels' })
  for (const text of [COMMS_NAME, ...Object.values(MODE_LABELS), ...Object.values(RAIL_GROUPS), NO_SERVICES, LOADING_LINE, UNREADABLE_SUB, EXAMPLE_BADGE, ...Object.values(READ_STATE_WORDS)]) {
    for (const banned of BANNED) assert.ok(!banned.test(text), `${JSON.stringify(text)} uses a banned name: ${banned}`)
  }
})

test('the inventory line counts each noun once, with plurals for 0/1/2', () => {
  const line = inventoryLine(report())
  assert.equal(line, '2 services · 3 channels · 5 messages · tool links: 2 live, 1 not answering')
  for (const banned of [...BANNED, ...COUNT_NOUNS]) assert.ok(!banned.test(line), `inventory uses ${banned}`)
  const one = inventoryLine(report({ services: 1, channels: 1, messages: 1 }))
  assert.match(one, /^1 service · 1 channel · 1 message · /)
  const none = inventoryLine(report({ services: 0, channels: 0, messages: 0 }))
  assert.match(none, /^0 services · 0 channels · 0 messages · /)
  /* each noun exactly once */
  for (const noun of ['service', 'channel', 'message', 'tool links']) {
    assert.equal((line.match(new RegExp(noun, 'g')) || []).length, 1, `${noun} is said once`)
  }
})

test('a part that could not be read says so in its own segment; the messages segment is left to the notice', () => {
  const channels = inventoryLine(report({ channelsOk: false }))
  assert.match(channels, /channels could not be read/)
  assert.doesNotMatch(channels, /\d+ channels?\b/)
  const mcp = inventoryLine(report({ mcpOk: false }))
  assert.match(mcp, /tool links could not be read/)
  const messages = inventoryLine(report({ messagesOk: false }))
  assert.doesNotMatch(messages, /message/, 'the notice above the card says it; the inventory does not repeat it')
  assert.match(messages, /^2 services · 3 channels · tool links: 2 live, 1 not answering$/)
  /* the sub line on a whole-read failure never carries a count */
  assert.doesNotMatch(UNREADABLE_SUB, /\d/)
})

test('every refusal is short, reads as sentences, is not a code, and names a next step', () => {
  const reasons = [
    READER_REFUSALS.NO_READER,
    READER_REFUSALS.NO_ANSWER,
    READER_REFUSALS.READ_THREW(new Error('socket closed')),
    READER_REFUSALS.READ_THREW('plain text'),
    READER_REFUSALS.READ_THREW(undefined),
    LOAD_FAILED(new Error('timed out')),
    LOAD_FAILED(null),
  ]
  for (const reason of reasons) {
    assert.ok(!IDENTIFIER_RE.test(reason.trim()), `${reason} is a bare code`)
    assert.match(reason, /[.!?]$/, `${reason} ends as a sentence`)
    for (const sentence of sentencesOf(reason)) {
      assert.ok(wordsOf(sentence).length <= 25, `${JSON.stringify(sentence)} is ${wordsOf(sentence).length} words`)
    }
    assert.match(reason, ACTION_VERB, `${reason} names nothing to do`)
    for (const banned of BANNED) assert.ok(!banned.test(reason), `${reason} uses ${banned}`)
  }
  assert.match(READER_REFUSALS.READ_THREW(undefined), /\(no reason given\)/)
  assert.match(READER_REFUSALS.READ_THREW(new Error('socket closed')), /\(socket closed\)/)
})

test('the empty lines are answers, distinct from the two whole-page notices', () => {
  for (const line of [emptyLine(), boardEmptyLine(), NO_SERVICES]) {
    assert.doesNotMatch(line, /could not|unavailable|failed/i, 'an empty answer is not a failure')
    assert.notEqual(line, commsQuietNotice().body)
    assert.notEqual(line, hostAbsentNotice().body)
    assert.ok(!commsQuietNotice().body.includes(line))
  }
  assert.notEqual(emptyLine(), boardEmptyLine())
})

test('describe(channel) is "{state} · {detail}", and just the state with no detail', () => {
  assert.equal(describe({ state: 'healthy', detail: 'sample board — demonstration traffic' }), 'healthy · sample board — demonstration traffic')
  assert.equal(describe({ state: 'stale', detail: '' }), 'stale')
  assert.equal(describe({ state: 'stale', detail: null }), 'stale')
  assert.equal(describe({}), 'unknown')
  assert.equal(serviceLine({ displayName: 'sample relay', transport: 'relay', port: 61411 }), 'sample relay · relay · port 61411')
})

test('the read-state word follows the root attribute, one word per state', () => {
  assert.equal(readStateWord('ready'), 'live')
  assert.equal(readStateWord('partial-unavailable'), 'partial')
  assert.equal(readStateWord('unavailable'), 'could not be read')
  assert.equal(readStateWord('simulated'), 'example')
  assert.equal(readStateWord('loading'), 'reading')
  assert.equal(readStateWord('nonsense'), 'reading')
})

test('short structured updates stay readable while long reports can be folded', () => {
  assert.equal(shouldFold('x'.repeat(FOLD_CHARS)), false, 'the exact character limit stays open')
  assert.equal(shouldFold('x'.repeat(FOLD_CHARS + 1)), true, 'one character over the limit folds')
  assert.equal(shouldFold('a\nb\nc'), false, 'two line breaks stay open')
  assert.equal(shouldFold('Update complete.\n\n- Tables wrap correctly.\n- Totals match.\n- Ready for review.'), false, 'a short report is readable without opening it')
  assert.equal(shouldFold('Another result.\n'.repeat(12)), true, 'a long list can be folded')
  assert.equal(shouldFold(''), false, 'empty text stays open')
  assert.equal(shouldFold(null), false, 'a missing value stays open')
})

test('foldSummary ends with the size in words and opens with the first sentence, cut at 90', () => {
  const summary = foldSummary('First sentence here. Second sentence is longer and says more.\nThird.')
  assert.match(summary, /· 11 words$/)
  assert.equal(summary, 'First sentence here… · 11 words')
  const long = foldSummary(`${'word '.repeat(40)}end. tail`)
  const head = long.split(' · ')[0]
  assert.ok(head.length <= 91, `${head.length} characters before the cut`)
  assert.ok(head.endsWith('…'))
  assert.match(long, /· 42 words$/)
  assert.match(foldSummary(''), /0 words$/)
})

test('rowModel: a notice prints no tag, an answer names its parent, an orphan prints nothing, an ask with no answer says so', () => {
  const messages = [
    { id: 'a1', sender: 'luna', at: '2026-08-20T10:00:00.000Z', text: 'Is the lock free?', kind: 'ask' },
    { id: 'n1', sender: 'controller', at: '2026-08-20T10:01:00.000Z', text: 'noted' },
    { id: 'r1', sender: 'codexb', at: '2026-08-20T10:02:00.000Z', text: 'Yes.', kind: 'answer', causalParent: 'a1', recipient: 'luna', senderMachine: 'host-b' },
    { id: 'o1', sender: 'codexb', at: '2026-08-20T10:03:00.000Z', text: 'orphan', kind: 'answer', causalParent: 'elsewhere' },
    { id: 'a2', sender: 'luna', at: '2026-08-20T10:04:00.000Z', text: 'And the lease?', kind: 'ask' },
  ]
  const byId = new Map(messages.map(m => [m.id, m]))
  const notice = rowModel(messages[1], byId)
  assert.equal(notice.kind, 'notice')
  assert.equal(notice.tag, '')
  assert.equal(notice.replyTo, '')
  assert.equal(notice.recipient, '')
  assert.equal(notice.machine, '')
  assert.equal(notice.noAnswer, false)
  const answered = rowModel(messages[0], byId)
  assert.equal(answered.tag, 'asked')
  assert.equal(answered.noAnswer, false, 'r1 answers a1')
  const reply = rowModel(messages[2], byId)
  assert.equal(reply.tag, 'answered')
  assert.equal(reply.replyTo, 'replying to luna')
  assert.equal(reply.parentId, 'a1')
  assert.equal(reply.recipient, 'luna')
  assert.equal(reply.machine, 'host-b')
  assert.equal(reply.at, Date.parse('2026-08-20T10:02:00.000Z'))
  const orphan = rowModel(messages[3], byId)
  assert.equal(orphan.replyTo, '', 'a parent outside the channel is a link to nowhere')
  assert.equal(orphan.parentId, '')
  const unanswered = rowModel(messages[4], byId)
  assert.equal(unanswered.noAnswer, true)
  assert.equal(NO_ANSWER_YET, 'no reply in loaded history, open the thread', 'an unloaded reply cannot be claimed absent')
  /* an unknown kind is a notice; a missing map is tolerated */
  assert.equal(rowModel({ id: 'x', sender: 's', text: 't', kind: 'shout' }).kind, 'notice')
  assert.ok(Object.isFrozen(notice))
  assert.deepEqual(KINDS, ['ask', 'answer', 'notice'])
})

test('senderHues are stable by first appearance and cycle the six role hues', () => {
  const hues = senderHues([{ sender: 'b' }, { sender: 'a' }, { sender: 'b' }, { sender: 'c' }])
  assert.equal(hues.get('b'), SENDER_HUES[0])
  assert.equal(hues.get('a'), SENDER_HUES[1])
  assert.equal(hues.get('c'), SENDER_HUES[2])
  assert.equal(hues.size, 3)
  const many = senderHues(Array.from({ length: 8 }, (unused, i) => ({ sender: `s${i}` })))
  assert.equal(many.get('s6'), SENDER_HUES[0], 'the seventh sender wraps to the first hue')
  assert.equal(senderHues(null).size, 0)
})

test('sender accents retain readable theme tokens independently of role preferences', () => {
  const sheet = readFileSync(new URL('../../src/theme-refinements.css', import.meta.url), 'utf8')
  const defaults = sheet.match(/:root\s*\{([^}]+)\}/)[1]
  for (const [theme, grounds] of Object.entries(ROLE_COLOR_THEMES)) {
    const blocks = [...sheet.matchAll(/(:root(?:\[data-theme="[a-z]+"\]|:is\([^)]*\))?)\s*\{([^}]+)\}/g)]
    const block = blocks.filter(([, selector]) => selector === ':root' || selector.includes(`[data-theme="${theme}"]`)).map(([, , body]) => body).join('\n')
    const declarations = Object.fromEntries([...`${defaults}\n${block}`.matchAll(/(--message-voice-\d+):\s*(#[a-f0-9]{6});/g)].map(match => [match[1], match[2]]))
    assert.equal(new Set(Object.values(declarations)).size, 6)
    for (const hue of SENDER_HUES) {
      const token = hue.match(/^var\((--message-voice-\d+), var\(--ink-2\)\)$/)?.[1]
      assert.ok(token && declarations[token], `${theme}: missing sender color ${hue}`)
      for (const ground of grounds) assert.ok(colorContrast(declarations[token], ground) >= 4.5, `${theme}: ${token} on ${ground}`)
    }
  }
  const painted = new Map()
  const documentRef = { documentElement: { dataset: { theme: 'black' }, style: { setProperty: (key, value) => painted.set(key, value), removeProperty: key => painted.delete(key) } } }
  const before = senderHues([{ sender: 'first' }, { sender: 'second' }])
  const storage = { getItem: () => JSON.stringify({ version: 1, colors: { coordinator: '#ff00ff', manager: '#00ffff' } }) }
  try {
    applyRoleColors({ documentRef, storage })
    assert.ok(painted.has('--role-accent-manager'), 'negative control must actually apply the role preference')
    assert.equal([...painted.keys()].some(key => key.startsWith('--message-voice-')), false)
    assert.deepEqual(senderHues([{ sender: 'first' }, { sender: 'second' }]), before)
  } finally {
    applyRoleColors({ documentRef: { documentElement: { dataset: { theme: 'white' } } }, storage: { getItem: () => null } })
  }
})

test('dayLabel across midnight on the local calendar', () => {
  const now = new Date(2026, 7, 22, 0, 10).getTime()           // 00:10 on 22 Aug
  assert.equal(dayLabel(now, now), 'Today')
  assert.equal(dayLabel(now - 20 * 60_000, now), 'Yesterday')   // 23:50 on 21 Aug
  assert.equal(dayLabel(new Date(2026, 7, 20, 23, 59).getTime(), now), '20 Aug')
  assert.equal(sameDay(now, now - 20 * 60_000), false)
  assert.equal(sameDay(now, now + 60_000), true)
})

test('a segment that is absent here does not read as a segment that is broken', () => {
  /* THE ONE EVERY CUSTOMER SAW. The tool-link inventory is written into the
     release report, and a computer that did not cut the release has no such
     report -- which is every customer machine, always. The line said "tool
     links could not be read", so a page whose whole job is to say what is
     working reported a permanent fault to everybody, about a thing that was
     simply not written down here. */
  const absent = inventoryLine(report({ mcpOk: false, mcpReason: NOT_RECORDED_HERE }))
  assert.match(absent, /tool links are not recorded on this computer/)
  const absentOverRelay = inventoryLine(
    report({ mcpOk: false, mcpReason: NOT_RECORDED_HERE }),
    { viaRelay: true },
  )
  assert.match(absentOverRelay, /tool links are not recorded on the computer you are driving/)
  assert.doesNotMatch(absent, /could not be read/,
    'absent must not be reported as a read failure -- they have different next steps')

  /* AND THE SAFE WRONG ANSWER STAYS THE DEFAULT. Any other reason -- including
     a real read failure, and including an internal string never written for a
     person -- keeps the fault sentence rather than being rendered verbatim to
     the glass. */
  for (const reason of ['EACCES', 'ENOENT_MISSING_REPORT', 'OPS_READ_THREW', '', null, undefined]) {
    const line = inventoryLine(report({ mcpOk: false, mcpReason: reason }))
    assert.match(line, /tool links could not be read/,
      `reason ${JSON.stringify(reason)} must fall back to the read-failure sentence`)
    if (typeof reason === 'string' && reason) {
      assert.doesNotMatch(line, new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        'an internal reason must never be rendered into the inventory line')
    }
  }

  /* The same rule, applied to the other segment that can go missing. */
  const channelsAbsent = inventoryLine(report({ channelsOk: false, channelsReason: NOT_RECORDED_HERE }))
  assert.match(channelsAbsent, /channels are not recorded on this computer/)
})

test('a count is never manufactured from a section that was never read', () => {
  /* "0 services" was printed on every machine that did not cut the release,
     because the services list lives in the same report the tool links do. A
     zero is not a hedge -- it is a definite answer, and it was invented. The
     inventory already knows how to omit a segment it cannot vouch for; it does
     exactly that for messages. */
  const unread = inventoryLine(report({ servicesRead: false }))
  assert.doesNotMatch(unread, /service/,
    'a services count must be omitted entirely when the list was never read, not printed as 0')
  assert.doesNotMatch(unread, /^0 /, 'and the line must not open on a manufactured zero')

  /* AND AN ACTUAL ZERO STILL SPEAKS. Omitting on unread must not swallow the
     real answer "we read it and there are none", which is a different fact. */
  const genuinelyNone = inventoryLine(report({ services: 0 }))
  assert.match(genuinelyNone, /0 services/,
    'a read list with nothing in it is an answer and must still be said')
})
