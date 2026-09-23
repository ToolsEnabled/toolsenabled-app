/* THE ACCOUNTS MENU'S DECISIONS, TESTED AS VALUES.
 *
 * src/account-switcher-state.js exists so that every rule the page-2 accounts
 * menu applies to a shell reply is a function of that reply and nothing else.
 * This is the suite that holds it to that. It runs no DOM: the module has none,
 * and a test that needed one would be a test of the wrong file.
 *
 * WHAT IS PINNED, AND WHY EACH ONE.
 *
 *   FAIL CLOSED. The module's header promises that an unread allowance is
 *   never rendered as 0% and an unrecognised reply is never rendered as a
 *   healthy account. Those are asserted here for every shape a reply can take,
 *   separately, because one test covering all of them can be satisfied by one
 *   early return.
 *
 *   ONE NAME PER PROVIDER. The registry allows "school" as both a Codex and a
 *   Claude account; the merge marks a row active by the provider's own answer
 *   (activeByProvider) and falls back to the single legacy name only when it
 *   names exactly one row.
 *
 *   THE WINDOW IS FIVE HOURS. The short window is five hours for both programs
 *   that report one; a sentence that said "this hour" beside "resets in 4h"
 *   could not be read. The slot names the window, not the payload's `kind`.
 *
 *   THE BRIDGE NEVER THROWS, AND KEEPS THE SHELL'S REASON. Every wrapper answers
 *   a record; a refusal record { ok: false, code, reason } from the shell keeps
 *   its own sentence and code so the menu can say why.
 *
 *   THREE COPIES OF ONE LIST. The mode ids live in the engine (packaged copy),
 *   the shell and this module; the store's header promised a test comparing
 *   them and none existed. This is that test.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  COPY,
  DEFAULT_RESERVE_PERCENT,
  DEFAULT_SELECTION_MODE,
  UNRECOGNISED_SELECTION_MODE,
  NOT_INSTALLED_CODE,
  PROVIDER_IDS,
  RANKED_MODE_IDS,
  SELECTION_MODE_CHOICES,
  SELECTION_MODE_IDS,
  USAGE_MEASURED_PROVIDERS,
  accountBars,
  accountSentence,
  accountsBridge,
  addManagedAccount,
  addRegisteredAccount,
  agePhrase,
  faultLine,
  removeAccount,
  renameAccount,
  usageIsStale,
  USAGE_STALE_MS,
  groupByProvider,
  isRankedMode,
  lastSwitchSentence,
  loadAccounts,
  loadUsage,
  mergeAccounts,
  movedOffParagraph,
  needsSignIn,
  accountKey,
  signInQueue,
  normalizeSelectionMode,
  onSignInChanged,
  readSignInChange,
  orderExplanation,
  orderParagraph,
  providerLabel,
  providerMeasuresUsage,
  readAccountList,
  readUsageReply,
  readWindow,
  readWindows,
  resetPhrase,
  rowFlags,
  rowLines,
  saveSelectionMode,
  selectionModeChoice,
  signInAccount,
  switchAccount,
  windowSentence,
  RANK_WINDOW_IDS,
  DEFAULT_RANK_WINDOW,
  normalizeRankWindow,
  rankWindowChoice,
  LEGACY_SELECTION_MODES,
} from '../../src/account-switcher-state.js'

test('a reported billing period keeps its own label and never duplicates a shared weekly meter', () => {
  const monthly = accountBars({ reportedUsage: { usedPercent: 40, period: 'month', resetsAt: null } })
  assert.equal(monthly.length, 1)
  assert.equal(monthly[0].label, COPY.monthlyBar)
  assert.equal(monthly[0].window.remainingPercent, 60)
  assert.match(monthly[0].sentence, /60% free this month/)
  const sharedWeek = { usedPercent: 20, remainingPercent: 80, resetsAt: null }
  const weekly = accountBars({ windows: { weekly: sharedWeek }, reportedUsage: { usedPercent: 20, period: 'week', resetsAt: null } })
  assert.equal(weekly.filter(bar => bar.window).length, 1, 'an existing shared weekly window is already the same period')
  const model = accountBars({ windows: { weeklyWindows: [{ ...sharedWeek, model: 'Model ceiling' }] }, reportedUsage: { usedPercent: 20, period: 'week', resetsAt: null } })
  assert.equal(model.filter(bar => bar.window).length, 2, 'a model ceiling does not replace a separately reported shared week')
  for (const usedPercent of [null, undefined, -1, 101, Number.NaN]) {
    assert.equal(accountBars({ reportedUsage: { usedPercent, period: 'month' } }).some(bar => bar.window), false)
  }
})

/* What every program's rule reads as when none has its own: the rule above,
   flagged as not its own. */
const inheritedRules = (selectionMode, reservePercent, rankWindow = 'either') => Object.fromEntries(
  ['codex', 'claude', 'gemini', 'grok'].map(id => [id, { selectionMode, reservePercent, rankWindow, own: { selectionMode: false, reservePercent: false, rankWindow: false } }]),
)

const require_ = createRequire(import.meta.url)
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/* A fixed clock, so "resets in 4h" is the same sentence on every run. */
const NOW = Date.parse('2026-09-02T12:00:00.000Z')
const inMs = ms => new Date(NOW + ms).toISOString()
const HOUR = 60 * 60 * 1000

/* ------------------------------ the mode table ------------------------------ */

test('the mode ids equal the packaged engine\'s and the shell\'s, in the same order', () => {
  const engine = require_(path.join(REPO, 'capability', 'src', 'lib', 'multi-account', 'selection-modes.js'))
  const shell = require_(path.join(REPO, 'shell', 'account-registry.cjs'))
  assert.deepEqual([...SELECTION_MODE_IDS], [...engine.SELECTION_MODE_IDS],
    'the menu offers a mode the packaged engine does not have (or the reverse); the engine normalises the stranger to manual, so the dropdown would show a choice the computer does not honour')
  assert.deepEqual([...SELECTION_MODE_IDS], [...shell.SELECTION_MODE_IDS],
    'the menu offers a mode the shell refuses (or the reverse); setPolicy() would answer ACCOUNT_MODE_UNSUPPORTED for a choice on the dropdown')
  assert.equal(DEFAULT_SELECTION_MODE, engine.DEFAULT_SELECTION_MODE)
  assert.equal(DEFAULT_RESERVE_PERCENT, engine.DEFAULT_RESERVE_PERCENT)
  /* The ranked set is derived from the engine's own table: every automatic
     mode except priority and Rotate ranks on allowance, and those are the modes under
     which the switch confirmation has to say the ranking takes over. */
  const ranked = engine.SELECTION_MODES.filter(mode => mode.automatic === true && !['priority', 'rotate'].includes(mode.id)).map(mode => mode.id)
  assert.deepEqual([...RANKED_MODE_IDS], ranked)
  assert.equal(engine.isAutomatic('manual'), false, 'manual must stay non-automatic; the "Never changes account on its own" sentence depends on it')
})

test('every mode has a label and a help sentence, manual is first, priority is the default, and the unknown falls to manual', () => {
  assert.equal(SELECTION_MODE_CHOICES[0].id, 'manual')
  assert.equal(DEFAULT_SELECTION_MODE, 'priority', 'nobody chose: walk the list (owner, 2026-09-02: added accounts should rotate)')
  assert.equal(UNRECOGNISED_SELECTION_MODE, 'manual')
  for (const choice of SELECTION_MODE_CHOICES) {
    assert.ok(choice.label.length > 0 && choice.help.length > 0, `${choice.id} has no words`)
    assert.equal(selectionModeChoice(choice.id), choice)
  }
  assert.equal(selectionModeChoice('nope'), null)
  for (const value of [undefined, null, '', 'automatic', 42, {}, 'MANUAL']) {
    assert.equal(normalizeSelectionMode(value), 'manual', `${JSON.stringify(value)} must fall to manual`)
  }
  assert.equal(isRankedMode('manual'), false)
  assert.equal(isRankedMode('priority'), false)
  assert.equal(isRankedMode('rotate'), false, 'Rotate follows the persisted cursor, not allowance rankings')
  assert.equal(normalizeSelectionMode('rotate'), 'rotate')
  assert.equal(selectionModeChoice('rotate').label, 'Rotate')
  for (const id of ['most-available', 'least-available', 'even', 'dynamic', 'resets-soonest']) assert.equal(isRankedMode(id), true)
})

test('the manual help promises only what the code does', () => {
  /* Finding 52: the first draft said this menu would name the ready account
     when work stopped, and nothing delivered that. The sentence must keep the
     pinned promise and must not promise the menu says anything on its own. */
  const help = selectionModeChoice('manual').help
  assert.ok(help.includes('Never changes account on its own'), 'the pinned promise left the manual help')
  assert.ok(!/names the account/i.test(help), 'the manual help promises the menu names a ready account; no code path delivers that')
})

/* ------------------------------ providers ------------------------------ */

test('four providers, and only two of them measure an allowance', () => {
  assert.deepEqual([...PROVIDER_IDS], ['codex', 'claude', 'gemini', 'grok'])
  assert.equal(providerLabel('gemini'), 'Gemini')
  assert.equal(providerLabel('grok'), 'Grok')
  assert.equal(providerLabel('nope'), 'nope')
  assert.equal(providerLabel(''), 'unknown')
  assert.deepEqual([...USAGE_MEASURED_PROVIDERS], ['codex', 'claude'])
  assert.equal(providerMeasuresUsage('gemini'), false, 'the engine does not read a Gemini allowance; a row that drew bars for one would draw "not known" forever')
  assert.equal(providerMeasuresUsage('grok'), false, 'Grok launch support does not invent an allowance measurement')
  assert.equal(providerMeasuresUsage('codex'), true)
  assert.equal(providerMeasuresUsage('claude'), true)
  assert.ok(COPY.usageNotMeasured.includes('Gemini'), 'the Gemini sentence has to name the program it is about')
})

/* ------------------------------ windows ------------------------------ */

for (const [name, value] of [
  ['undefined', undefined],
  ['null', null],
  ['an array', []],
  ['a number', 40],
  ['an empty object', {}],
  ['usedPercent as a string', { usedPercent: '40' }],
  ['usedPercent negative', { usedPercent: -1 }],
  ['usedPercent over 100', { usedPercent: 101 }],
  ['usedPercent NaN', { usedPercent: NaN }],
  ['only remainingPercent', { remainingPercent: 60 }],
]) {
  test(`fails closed: readWindow of ${name} is null, never a number`, () => {
    assert.equal(readWindow(value), null)
    assert.equal(readWindow(value, 'weekly'), null)
  })
}

test('readWindow keeps a measured window and derives the remainder when it is absent', () => {
  const window = readWindow({ usedPercent: 40, resetsAt: inMs(3 * HOUR), label: 'primary' })
  assert.equal(window.usedPercent, 40)
  assert.equal(window.remainingPercent, 60)
  assert.equal(window.kind, 'hourly')
  assert.equal(window.label, 'primary')
  assert.equal(Object.isFrozen(window), true)
  const stated = readWindow({ usedPercent: 40, remainingPercent: 55 })
  assert.equal(stated.remainingPercent, 55, 'a stated remainder wins over the derived one')
  const zero = readWindow({ usedPercent: 0 })
  assert.equal(zero.usedPercent, 0)
  assert.equal(zero.remainingPercent, 100)
})

test('the slot names the window; the payload\'s kind field does not', () => {
  /* Finding 41: a weekly-slot window that forgot to say kind was sentenced as
     the short window while sitting in the bar labelled "this week". */
  assert.equal(readWindow({ usedPercent: 10, kind: 'weekly' }).kind, 'hourly', 'a kind field with no slot must not promote a window')
  assert.equal(readWindow({ usedPercent: 10 }, 'weekly').kind, 'weekly')
  assert.equal(readWindow({ usedPercent: 10, kind: 'hourly' }, 'weekly').kind, 'weekly', 'the slot wins over a contradicting field')
  const windows = readWindows({ hourly: { usedPercent: 10 }, weekly: { usedPercent: 60 } })
  assert.equal(windows.hourly.kind, 'hourly')
  assert.equal(windows.weekly.kind, 'weekly')
  const weeklyOnly = readWindows({ weekly: { usedPercent: 60 } })
  assert.equal(weeklyOnly.hourly, null)
  assert.equal(weeklyOnly.weekly.kind, 'weekly')
  for (const junk of [undefined, null, [], 'x', 3]) {
    assert.deepEqual(readWindows(junk), { hourly: null, weekly: null, weeklyWindows: [] })
  }
})

test('windowSentence calls the short window a 5-hour window and never "this hour"', () => {
  const short = readWindow({ usedPercent: 18, resetsAt: inMs(4 * HOUR) }, 'hourly')
  const sentence = windowSentence(short, { now: NOW })
  assert.equal(sentence, '82% free this 5-hour window · resets in 4h')
  assert.ok(!/\bthis hour\b/.test(sentence), 'the five-hour window was called an hour again')
  assert.ok(!/\bhourly\b/.test(sentence))
  const week = readWindow({ usedPercent: 97, resetsAt: inMs(6 * 24 * HOUR) }, 'weekly')
  assert.equal(windowSentence(week, { now: NOW }), '3% free this week · resets in 6 days')
  assert.equal(windowSentence(readWindow({ usedPercent: 50 })), '50% free this 5-hour window', 'no resetsAt, no reset clause')
  assert.equal(windowSentence(null), COPY.usageUnknown)
  /* The bar labels say the same thing in fewer words, and never "hour" alone. */
  assert.equal(COPY.hourlyBar, '5-hour window')
  assert.equal(COPY.weeklyBar, 'this week')
})

test('the sentence and the figure speak the same quantity: percent free', () => {
  /* Finding 44: the bar printed "97%" (used) beside a tooltip saying "3% free". */
  assert.equal(COPY.percentFree(3), '3% free')
  assert.equal(COPY.roomLeft(3), '3% left')
  const window = readWindow({ usedPercent: 97 })
  assert.ok(windowSentence(window).startsWith(COPY.percentFree(3)), 'the sentence must lead with the same "% free" figure the bar prints')
})

test('resetPhrase speaks in words, says "under a minute" for the last seconds, and drops what it cannot parse', () => {
  assert.equal(resetPhrase(inMs(20 * 1000), { now: NOW }), 'resets in under a minute')
  assert.equal(resetPhrase(inMs(29 * 1000), { now: NOW }), 'resets in under a minute')
  assert.equal(resetPhrase(inMs(5 * 60 * 1000), { now: NOW }), 'resets in 5 min')
  assert.equal(resetPhrase(inMs(3 * HOUR), { now: NOW }), 'resets in 3h')
  assert.equal(resetPhrase(inMs(47 * HOUR), { now: NOW }), 'resets in 47h')
  assert.equal(resetPhrase(inMs(3 * 24 * HOUR), { now: NOW }), 'resets in 3 days')
  assert.equal(resetPhrase(inMs(0), { now: NOW }), 'due to reset')
  assert.equal(resetPhrase(inMs(-HOUR), { now: NOW }), 'due to reset')
  assert.equal(resetPhrase('not a time', { now: NOW }), '')
  assert.equal(resetPhrase(undefined, { now: NOW }), '')
  assert.ok(!/\b0 min\b/.test(resetPhrase(inMs(1000), { now: NOW })), '"resets in 0 min" is back')
})

/* ------------------------------ the list ------------------------------ */

for (const [name, value] of [
  ['undefined', undefined],
  ['null', null],
  ['an array', []],
  ['a string', 'ok'],
  ['an empty object', {}],
  ['ok as the string "true"', { ok: 'true', accounts: [] }],
  ['ok false', { ok: false, code: 'ACCOUNT_REGISTRY_DAMAGED', accounts: [] }],
  ['accounts missing', { ok: true }],
  ['accounts as an object', { ok: true, accounts: {} }],
]) {
  test(`fails closed: a list reply of ${name} is unavailable with a reason, not an empty list`, () => {
    const list = readAccountList(value)
    assert.equal(list.available, false)
    assert.equal(list.damaged, false)
    assert.deepEqual([...list.accounts], [])
    assert.equal(list.active, null)
    assert.equal(list.activeByProvider, null)
    assert.equal(list.note, COPY.unavailable)
    assert.equal(list.policy.selectionMode, 'priority', 'nothing recorded reads as the default, the listed order')
    assert.equal(list.policy.recorded, false)
    assert.equal(list.policy.reservePercent, DEFAULT_RESERVE_PERCENT)
  })
}

// Positive fixtures name explicit opaque identities. Missing/malformed binding
// tests below pass their raw values through the production readers unchanged.
const FIXTURE_BINDINGS = Object.freeze({
  codexSchool: '1'.repeat(64), claudeSchool: '2'.repeat(64), geminiWork: '3'.repeat(64),
  claudeWork: '4'.repeat(64), antigravity: '5'.repeat(64), grok: '6'.repeat(64),
})

const LIST_REPLY = Object.freeze({
  ok: true,
  accounts: [
    { name: 'school', provider: 'codex', allowanceBinding: FIXTURE_BINDINGS.codexSchool, directory: '.codex-school', priority: 1, signedIn: 'yes', command: 'codex login' },
    { name: 'school', provider: 'claude', allowanceBinding: FIXTURE_BINDINGS.claudeSchool, directory: '.claude-school', priority: 2, signedIn: 'no' },
    { name: 'work', provider: 'gemini', allowanceBinding: FIXTURE_BINDINGS.geminiWork, priority: 3, signedIn: 'maybe' },
    { name: '', provider: 'codex' },
    { name: 'stranger', provider: 'copilot' },
    'not an account',
  ],
  active: { name: 'school', provider: 'codex', at: '2026-09-02T11:00:00.000Z' },
  activeByProvider: { codex: 'school', claude: null, gemini: { name: 'work' } },
  policy: { selectionMode: 'dynamic', recorded: true, reservePercent: 40 },
})

test('a well-formed list is normalised: names, providers, the three-valued sign-in, the policy and who is on what', () => {
  const list = readAccountList(LIST_REPLY)
  assert.equal(list.available, true)
  assert.equal(list.damaged, false)
  assert.deepEqual(list.accounts.map(account => `${account.provider}:${account.name}`), ['codex:school', 'claude:school', 'gemini:work'],
    'a nameless row and an unknown provider are dropped; Gemini is kept')
  assert.equal(list.accounts[0].signedIn, true)
  assert.equal(list.accounts[1].signedIn, false)
  assert.equal(list.accounts[2].signedIn, null, 'an answer this build does not recognise is "not said", never "not signed in"')
  assert.equal(list.accounts[0].command, 'codex login')
  assert.equal(list.active, 'school')
  assert.equal(list.activeProvider, 'codex')
  assert.equal(list.activeAt, '2026-09-02T11:00:00.000Z')
  assert.deepEqual({ ...list.activeByProvider }, { codex: 'school', claude: null, gemini: 'work', grok: null },
    'a per-provider entry may be a name or a record with a name')
  assert.deepEqual({ ...list.policy }, { autoRecoverOnLimit: true, selectionMode: 'dynamic', recorded: true, reservePercent: 40, rankWindow: 'either', exhaustedAtPercent: 99, exhaustedAtPercentHourly: null, exhaustedAtPercentWeekly: null, byProvider: inheritedRules('dynamic', 40) })
  assert.equal(list.note, null)
})

test('the policy may arrive wrapped, and anything unreadable in it falls to the safe values', () => {
  const wrapped = readAccountList({ ok: true, accounts: [], policy: { ok: true, policy: { selectionMode: 'even', recorded: true, reservePercent: 10 } } })
  assert.deepEqual({ ...wrapped.policy }, { autoRecoverOnLimit: true, selectionMode: 'even', recorded: true, reservePercent: 10, rankWindow: 'either', exhaustedAtPercent: 99, exhaustedAtPercentHourly: null, exhaustedAtPercentWeekly: null, byProvider: inheritedRules('even', 10) })
  const odd = readAccountList({ ok: true, accounts: [], policy: { selectionMode: 'random', recorded: 'yes', reservePercent: 500 } })
  assert.deepEqual({ ...odd.policy }, { autoRecoverOnLimit: true, selectionMode: 'manual', recorded: false, reservePercent: DEFAULT_RESERVE_PERCENT, rankWindow: 'either', exhaustedAtPercent: 99, exhaustedAtPercentHourly: null, exhaustedAtPercentWeekly: null, byProvider: inheritedRules('manual', DEFAULT_RESERVE_PERCENT) })

  /* THE TWO PER-WINDOW LIMITS SURVIVE THE READ, and an absent one stays null
     rather than becoming a copy of the single number. The menu draws the
     difference between a limit somebody chose and one they inherited, so it
     has to still be able to tell them apart this far down. */
  const limits = readAccountList({ ok: true, accounts: [], policy: {
    selectionMode: 'even', recorded: true, reservePercent: 10,
    exhaustedAtPercent: 90, exhaustedAtPercentWeekly: 95
  } })
  assert.equal(limits.policy.exhaustedAtPercent, 90)
  assert.equal(limits.policy.exhaustedAtPercentWeekly, 95, 'a weekly limit that was chosen is read back')
  assert.equal(limits.policy.exhaustedAtPercentHourly, null, 'a window with no limit of its own reads as null, not as 90')

  const spoiled = readAccountList({ ok: true, accounts: [], policy: {
    selectionMode: 'even', exhaustedAtPercent: 'ninety', exhaustedAtPercentWeekly: 500, exhaustedAtPercentHourly: true
  } })
  assert.equal(spoiled.policy.exhaustedAtPercent, 99, 'an unreadable single number falls to the engine default')
  assert.equal(spoiled.policy.exhaustedAtPercentWeekly, null, 'a limit out of range is no limit')
  assert.equal(spoiled.policy.exhaustedAtPercentHourly, null, 'a boolean is no limit')
  assert.equal(readAccountList({ ok: true, accounts: [] }).activeByProvider, null, 'an older shell that did not say is null, not an empty table')
})

/* ------------------------- the last change of account ------------------------- */

/* THE DEFECT THESE HOLD SHUT. The shell answered the CLOCK TIME of the last
   switch and threw the rest of the record away, so the menu could say this
   computer changed account and never that it changed FROM one account TO
   another, or that it did so on its own. An automatic failover is exactly the
   change nobody was present for, and it was the one nothing could describe. */
const switchedList = (lastSwitch) => readAccountList({ ok: true, accounts: [], lastSwitch })

test('a failover says which account it left, which it took, and that the computer did it', () => {
  const change = lastSwitchSentence(switchedList({
    at: inMs(-12 * 60 * 1000), from: 'work', to: 'spare', provider: 'claude', automatic: true,
    reason: 'The account in use had reached its weekly limit.',
  }), { now: NOW })
  assert.equal(change.text, 'Claude: This computer moved from “work” to “spare” on its own, 12 min ago.')
  assert.equal(change.reason, 'It gave this reason: The account in use had reached its weekly limit.')
  assert.equal(change.automatic, true)
})

test('a change the person made never reads as one the computer made, and neither does a record that did not say', () => {
  /* Three facts, three sentences. Telling somebody the computer moved their
     work when they moved it themselves is the same class of untruth as the
     reverse, and a record written before `automatic` existed said neither. */
  const byHand = lastSwitchSentence(switchedList({
    at: inMs(-2 * HOUR), from: 'work', to: 'spare', provider: 'codex', automatic: false,
  }), { now: NOW })
  assert.equal(byHand.text, 'Codex: You switched to “spare” 2h ago.')
  assert.equal(byHand.reason, null, 'a switch with no reason recorded invented one')

  const unstated = lastSwitchSentence(switchedList({
    at: inMs(-2 * HOUR), from: 'work', to: 'spare',
  }), { now: NOW })
  assert.equal(unstated.text, 'The account in use changed to “spare” 2h ago.')
  assert.equal(unstated.automatic, null)

  /* The program is named only when the record named it: guessing it would tell
     somebody their Codex work moved when their Claude work did. */
  assert.equal(lastSwitchSentence(switchedList({
    at: inMs(-2 * HOUR), to: 'spare', provider: 'not-a-program', automatic: true,
  }), { now: NOW }).text, 'This computer chose “spare” on its own, 2h ago.')
})

test('nothing to say is null, and an unreadable time is still a change worth reporting', () => {
  assert.equal(lastSwitchSentence(readAccountList({ ok: true, accounts: [] })), null,
    'a computer that has never switched was told it had')
  assert.equal(lastSwitchSentence(switchedList({ automatic: true })), null,
    'a record naming neither a time nor an account drew as a change')
  assert.equal(lastSwitchSentence(null), null)
  assert.equal(lastSwitchSentence({}), null)
  /* "The record is unreadable" is not "no switch happened". */
  const noTime = lastSwitchSentence(switchedList({ to: 'spare', automatic: true, from: 'work' }), { now: NOW })
  assert.equal(noTime.text, 'This computer moved from “work” to “spare” on its own, at a time this computer did not record.')
})

test('the switch record is read field by field, never carried across whole', () => {
  /* The engine's switcher owns that file and may grow fields; a screen must
     never be handed a value nothing here has read. */
  const list = switchedList({
    at: inMs(-60 * 1000), from: 'w'.repeat(200), to: 's'.repeat(200), provider: 'claude',
    automatic: 'yes', reason: 'r'.repeat(500), somethingLater: 'a field this build has never heard of',
  })
  assert.equal(list.lastSwitch.from.length, 64)
  assert.equal(list.lastSwitch.to.length, 64)
  assert.equal(list.lastSwitch.reason.length, 240)
  assert.equal(list.lastSwitch.automatic, null, 'a value that is not a boolean was read as one')
  assert.equal(Object.hasOwn(list.lastSwitch, 'somethingLater'), false, 'an unread field was copied to the screen')
  assert.ok(Object.isFrozen(list.lastSwitch))
  /* A shell too old to answer it says nothing rather than a record of nulls. */
  assert.equal(readAccountList({ ok: true, accounts: [] }).lastSwitch, null)
  assert.equal(readAccountList({ ok: true, accounts: [], lastSwitch: 'soon' }).lastSwitch, null)
  assert.equal(readAccountList(null).lastSwitch, null, 'an unavailable shell still answers the field')
})

test('damaged and empty lists carry their own sentences', () => {
  const damaged = readAccountList({ ok: true, damaged: true, accounts: [] })
  assert.equal(damaged.damaged, true)
  assert.equal(damaged.note, COPY.damaged)
  const empty = readAccountList({ ok: true, accounts: [] })
  assert.equal(empty.note, COPY.none)
})

/* ------------------------------ the usage reply ------------------------------ */

for (const [name, value] of [
  ['undefined', undefined],
  ['null', null],
  ['an array', []],
  ['a string', 'ok'],
  ['ok as the string "true"', { ok: 'true', accounts: [] }],
  ['accounts missing', { ok: true }],
]) {
  test(`fails closed: a usage reply of ${name} is not ok, with the unavailable sentence and no readings`, () => {
    const usage = readUsageReply(value)
    assert.equal(usage.ok, false)
    assert.equal(usage.reason, COPY.usageUnavailable)
    assert.deepEqual({ ...usage.readings }, {})
    assert.deepEqual([...usage.orders], [])
  })
}

test('a refusal with a reason keeps the reason, and a reading is keyed by provider and lower-cased name', () => {
  assert.equal(readUsageReply({ ok: false, reason: 'The list could not be read.' }).reason, 'The list could not be read.')
  const usage = readUsageReply({
    ok: true,
    accounts: [
      { name: 'School', provider: 'codex', allowanceBinding: FIXTURE_BINDINGS.codexSchool, status: 'HEALTHY', canServe: true, usedPercent: 18, windows: { hourly: { usedPercent: 18 }, weekly: { usedPercent: 40 } }, planType: 'plus' },
      { name: 'work', provider: 'claude', allowanceBinding: FIXTURE_BINDINGS.claudeWork, status: 'EXHAUSTED', canServe: 'yes', usedPercent: 'lots', reason: 'spent' },
      { name: 'x', provider: 'copilot', usedPercent: 1 },
      null,
    ],
    orders: [{ provider: 'codex', names: ['School', 7, ''], why: 'School has the most left.' }, { provider: 'nope' }, 'x'],
  })
  assert.equal(usage.ok, true)
  assert.deepEqual(Object.keys(usage.readings).sort(), ['claude:work', 'codex:school'])
  assert.equal(usage.readings['codex:school'].windows.weekly.kind, 'weekly')
  assert.equal(usage.readings['codex:school'].canServe, true)
  assert.equal(usage.readings['claude:work'].canServe, false, 'canServe is true only for the boolean true')
  assert.equal(usage.readings['claude:work'].usedPercent, null, 'a non-numeric percent is null, never 0')
  assert.deepEqual(usage.readings['claude:work'].windows, { hourly: null, weekly: null, weeklyWindows: [] })
  assert.deepEqual(usage.orders.map(order => ({ ...order, names: [...order.names] })), [{ provider: 'codex', names: ['School'], why: 'School has the most left.' }])
})

/* ------------------------------ the merge ------------------------------ */

test('mergeAccounts marks a row active by its provider\'s own answer, so two "school" rows are not both in use', () => {
  const rows = mergeAccounts(readAccountList(LIST_REPLY), null)
  assert.deepEqual(rows.map(row => [row.provider, row.name, row.active]), [
    ['codex', 'school', true],
    ['claude', 'school', false],
    ['gemini', 'work', true],
  ])
})

test('without a per-provider answer, the legacy name marks a row only when it names exactly one', () => {
  const shared = readAccountList({ ...LIST_REPLY, active: { name: 'school' }, activeByProvider: undefined })
  assert.deepEqual(mergeAccounts(shared, null).map(row => row.active), [false, false, false],
    'two rows share the name, so neither is guessed active and both keep their switch button')
  const unique = readAccountList({ ...LIST_REPLY, active: { name: 'WORK' }, activeByProvider: undefined })
  assert.deepEqual(mergeAccounts(unique, null).map(row => row.active), [false, false, true], 'a unique name is honoured, case-insensitively')
  const withProvider = readAccountList({ ...LIST_REPLY, active: { name: 'school', provider: 'claude' }, activeByProvider: undefined })
  assert.deepEqual(mergeAccounts(withProvider, null).map(row => row.active), [false, true, false], 'a legacy answer that names its provider is exact')
  const none = readAccountList({ ...LIST_REPLY, active: null, activeByProvider: undefined })
  assert.deepEqual(mergeAccounts(none, null).map(row => row.active), [false, false, false])
})

test('an unmeasured account is unmeasured: no windows, no binding, no number, and its sentence says so', () => {
  for (const usage of [null, undefined, readUsageReply(null), readUsageReply({ ok: true, accounts: [] })]) {
    for (const row of mergeAccounts(readAccountList(LIST_REPLY), usage)) {
      assert.equal(row.measured, false)
      assert.equal(row.binding, null)
      assert.equal(row.windows.hourly, null)
      assert.equal(row.windows.weekly, null)
      assert.equal(row.status, null)
      assert.equal(row.canServe, null)
      assert.equal(accountSentence(row), COPY.usageUnknown)
      assert.ok(!JSON.stringify(row).includes('"remainingPercent":0'), 'an unread window rendered as 0% -- the one lie this module exists to refuse')
    }
  }
})

test('a measured account carries its readings, binds on the worse window and says both in one line', () => {
  const usage = readUsageReply({
    ok: true,
    accounts: [{
      name: 'school', provider: 'codex', allowanceBinding: FIXTURE_BINDINGS.codexSchool, status: 'HEALTHY', canServe: true,
      windows: { hourly: { usedPercent: 18, resetsAt: inMs(4 * HOUR) }, weekly: { usedPercent: 60, resetsAt: inMs(6 * 24 * HOUR) } },
    }],
  })
  const rows = mergeAccounts(readAccountList(LIST_REPLY), usage)
  const codex = rows.find(row => row.provider === 'codex')
  assert.equal(codex.measured, true)
  assert.equal(codex.canServe, true)
  assert.equal(codex.binding.kind, 'weekly', 'the window that is hit first is the honest single number')
  assert.equal(codex.binding.remainingPercent, 40)
  assert.equal(accountSentence(codex, { now: NOW }), '82% free this 5-hour window · resets in 4h · 40% free this week · resets in 6 days')
  const claude = rows.find(row => row.provider === 'claude')
  assert.equal(claude.measured, false, 'a reading for the Codex "school" must not measure the Claude "school"')
})

test('both weekly ceilings reach the row, named apart, while the binding one is unchanged', () => {
  /* MEASURED 2026-09-02 (Claude Code 2.1.258): `get_usage` answered a week
     across all models at 25% used and a Fable-scoped week at 46%, active. One
     weekly slot could carry only the second, so the row said "this week · 54%
     free" and named neither week. */
  const usage = readUsageReply({
    ok: true,
    accounts: [{
      name: 'school', provider: 'claude', allowanceBinding: FIXTURE_BINDINGS.claudeSchool, status: 'HEALTHY', canServe: true,
      windows: {
        hourly: { usedPercent: 21, label: 'session', resetsAt: inMs(4 * HOUR) },
        weekly: { usedPercent: 46, label: 'weekly_scoped · Fable', model: 'Fable', resetsAt: inMs(6 * 24 * HOUR) },
        weeklyWindows: [
          { usedPercent: 25, label: 'weekly_all', resetsAt: inMs(6 * 24 * HOUR) },
          { usedPercent: 46, label: 'weekly_scoped · Fable', model: 'Fable', resetsAt: inMs(6 * 24 * HOUR) },
        ],
      },
    }],
  })
  const row = mergeAccounts(readAccountList(LIST_REPLY), usage).find(entry => entry.provider === 'claude')
  assert.deepEqual(row.windows.weeklyWindows.map(window => [window.model, window.usedPercent]), [[null, 25], ['Fable', 46]])
  assert.deepEqual(accountBars(row, { now: NOW }).map(bar => bar.label),
    [COPY.hourlyBar, 'this week (all models)', 'this week (Fable)'],
    'the week that covers the plan and the week that covers one model say which they are')
  assert.deepEqual(accountBars(row, { now: NOW }).map(bar => bar.window && bar.window.remainingPercent), [79, 75, 54])
  assert.equal(accountSentence(row, { now: NOW }),
    '79% free this 5-hour window · resets in 4h · 75% free this week (all models) · resets in 6 days · 54% free this week (Fable) · resets in 6 days')
  assert.equal(row.binding.usedPercent, 46, 'the row still binds on the ceiling that stops a run, not on the roomier week')
  assert.equal(row.measured, true)

  /* AN ENGINE THAT SENDS ONE WEEK IS NOT AN ENGINE THAT SENT NOTHING. Its
     single reading keeps the plain label and the two bars the menu has always
     drawn -- "(all models)" beside a lone bar would send a person looking for
     a second one that does not exist. */
  const oneWeek = readUsageReply({
    ok: true,
    accounts: [{
      name: 'school', provider: 'codex', allowanceBinding: FIXTURE_BINDINGS.codexSchool, status: 'HEALTHY', canServe: true,
      windows: { hourly: { usedPercent: 18 }, weekly: { usedPercent: 60 } },
    }],
  })
  const codex = mergeAccounts(readAccountList(LIST_REPLY), oneWeek).find(entry => entry.provider === 'codex')
  assert.deepEqual(accountBars(codex).map(bar => bar.label), [COPY.hourlyBar, COPY.weeklyBar])
  assert.equal(accountSentence(codex, { now: NOW }), '82% free this 5-hour window · 40% free this week')

  /* A row nothing was read for still draws both bars, with no window in
     either, so the menu can say "not known" where a figure would go. */
  const unread = mergeAccounts(readAccountList(LIST_REPLY), null)[0]
  assert.deepEqual(accountBars(unread).map(bar => [bar.label, bar.window]), [[COPY.hourlyBar, null], [COPY.weeklyBar, null]])
})

test('two weekly ceilings that name no model are told apart by the provider\'s own word for each', () => {
  const usage = readUsageReply({
    ok: true,
    accounts: [{
      name: 'school', provider: 'codex', allowanceBinding: FIXTURE_BINDINGS.codexSchool, status: 'HEALTHY', canServe: true,
      windows: {
        hourly: null,
        weekly: { usedPercent: 70, label: 'secondary · 10080 min' },
        weeklyWindows: [
          { usedPercent: 30, label: 'primary · 1500 min' },
          { usedPercent: 70, label: 'secondary · 10080 min' },
        ],
      },
    }],
  })
  const row = mergeAccounts(readAccountList(LIST_REPLY), usage).find(entry => entry.provider === 'codex')
  assert.deepEqual(accountBars(row).map(bar => bar.label),
    [COPY.hourlyBar, 'this week (primary · 1500 min)', 'this week (secondary · 10080 min)'],
    'neither ceiling is dropped for being unnameable, and neither reads as the other')
})

test('groupByProvider heads each program\'s rows with its name and drops empty groups', () => {
  const groups = groupByProvider(mergeAccounts(readAccountList(LIST_REPLY), null))
  assert.deepEqual(groups.map(group => [group.provider, group.label, group.accounts.length]), [
    ['codex', 'Codex', 1], ['claude', 'Claude', 1], ['gemini', 'Gemini', 1],
  ])
  assert.deepEqual([...groupByProvider([])], [])
})

/* ------------------------------ the bridge ------------------------------ */

function fakeScope(bridge) {
  return { mcProviders: { accounts: async () => LIST_REPLY, ...bridge } }
}

const REFUSAL = Object.freeze({
  ok: false,
  code: 'ACCOUNT_REGISTRY_ABSENT',
  reason: 'There are no accounts on this computer yet, so there is nothing to choose between.',
})

test('no bridge, or a partial one, is unavailable -- and no wrapper ever throws', async () => {
  assert.equal(accountsBridge({}), null)
  assert.equal(accountsBridge({ mcProviders: {} }), null, 'a bridge with no accounts() is not a bridge')
  assert.equal(accountsBridge(undefined), null)
  assert.equal((await loadAccounts({})).available, false)
  assert.equal((await loadUsage({})).ok, false)
  for (const wrapper of [saveSelectionMode, switchAccount, addManagedAccount, signInAccount]) {
    const answer = await wrapper({}, {})
    assert.equal(answer.ok, false)
    assert.equal(answer.reason, COPY.unavailable)
  }
  /* The list arrow alone does not make the other arrows exist. */
  const listOnly = fakeScope({})
  assert.equal((await loadUsage(listOnly)).ok, false)
  assert.equal((await saveSelectionMode({ selectionMode: 'even' }, listOnly)).reason, COPY.unavailable)
  assert.equal((await switchAccount({ name: 'school', provider: 'codex' }, listOnly)).reason, COPY.unavailable)
  assert.equal((await addManagedAccount({ provider: 'codex' }, listOnly)).reason, COPY.unavailable)
  assert.equal((await signInAccount({ name: 'school', provider: 'codex' }, listOnly)).reason, COPY.unavailable)
})

test('a bridge that throws reads as unavailable or refused, never as a crash', async () => {
  const boom = async () => { throw new Error('ACCOUNT_STATE_UNAVAILABLE') }
  const scope = fakeScope({ accounts: boom, accountUsage: boom, accountPolicy: boom, accountSwitch: boom, accountAddManaged: boom, accountSignIn: boom })
  assert.equal((await loadAccounts(scope)).available, false)
  assert.equal((await loadUsage(scope)).ok, false)
  const policy = await saveSelectionMode({ selectionMode: 'even' }, scope)
  assert.deepEqual({ ...policy }, { ok: false, code: null, reason: COPY.modeRefused })
  assert.equal((await switchAccount({ name: 'school', provider: 'codex' }, scope)).reason, COPY.switchRefused)
  assert.equal((await addManagedAccount({ provider: 'codex' }, scope)).reason, COPY.addRefused)
  assert.equal((await signInAccount({ name: 'school', provider: 'codex' }, scope)).reason, COPY.signInRefused)
})

test('loadAccounts and loadUsage hand back the normalised replies', async () => {
  const scope = fakeScope({ accountUsage: async () => ({ ok: true, accounts: [{ name: 'school', provider: 'codex', allowanceBinding: FIXTURE_BINDINGS.codexSchool, windows: { hourly: { usedPercent: 5 } } }] }) })
  const list = await loadAccounts(scope)
  assert.equal(list.available, true)
  assert.equal(list.accounts.length, 3)
  const usage = await loadUsage(scope)
  assert.equal(usage.ok, true)
  assert.equal(usage.readings['codex:school'].windows.hourly.remainingPercent, 95)
})

test('a refusal record from the shell keeps its own sentence and code, on every channel', async () => {
  /* Finding 4: every refusal used to arrive as an Error whose message was the
     code, so five different causes rendered as one generic sentence. The shell
     now answers { ok: false, code, reason } and the wrapper keeps both. */
  const refuse = async () => REFUSAL
  const scope = fakeScope({ accountPolicy: refuse, accountSwitch: refuse, accountAddManaged: refuse, accountSignIn: refuse })
  for (const wrapper of [saveSelectionMode, switchAccount, addManagedAccount, signInAccount]) {
    const answer = await wrapper({ name: 'school', provider: 'codex', selectionMode: 'even' }, scope)
    assert.equal(answer.ok, false)
    assert.equal(answer.code, 'ACCOUNT_REGISTRY_ABSENT')
    assert.equal(answer.reason, REFUSAL.reason, `${wrapper.name} dropped the shell's own sentence`)
  }
  /* A refusal WITHOUT a sentence falls to the channel's own fallback. */
  const bare = async () => ({ ok: false, code: 'ACCOUNT_UNKNOWN' })
  const bareScope = fakeScope({ accountPolicy: bare, accountSwitch: bare, accountAddManaged: bare, accountSignIn: bare })
  assert.equal((await saveSelectionMode({}, bareScope)).reason, COPY.modeRefused)
  assert.equal((await switchAccount({}, bareScope)).reason, COPY.switchRefused)
  assert.equal((await addManagedAccount({}, bareScope)).reason, COPY.addRefused)
  assert.equal((await signInAccount({}, bareScope)).reason, COPY.signInRefused)
  assert.equal((await switchAccount({}, bareScope)).code, 'ACCOUNT_UNKNOWN')
})

test('saveSelectionMode forwards the request untouched and reads only ok:true as saved', async () => {
  const sent = []
  const scope = fakeScope({ accountPolicy: async request => { sent.push(request); return { ok: true } } })
  const answer = await saveSelectionMode({ selectionMode: 'dynamic', reservePercent: 30 }, scope)
  assert.deepEqual({ ...answer }, { ok: true, code: null, reason: null })
  assert.deepEqual(sent, [{ selectionMode: 'dynamic', reservePercent: 30 }])
  await saveSelectionMode({ selectionMode: 'even' }, scope)
  assert.equal('reservePercent' in sent[1], false, 'a request without a reserve must not grow one on the way through')
  for (const odd of [undefined, null, [], 'ok', { ok: 'true' }, { ok: 1 }]) {
    const refused = await saveSelectionMode({ selectionMode: 'even' }, fakeScope({ accountPolicy: async () => odd }))
    assert.equal(refused.ok, false, `${JSON.stringify(odd)} must not read as saved`)
  }
})

test('switchAccount tells "switched" from "already there" and carries the active record', async () => {
  const sent = []
  const scope = fakeScope({
    accountSwitch: async request => {
      sent.push(request)
      return { ok: true, switched: request.name !== 'school', active: { name: request.name, provider: request.provider } }
    },
  })
  const moved = await switchAccount({ name: 'work', provider: 'gemini' }, scope)
  assert.equal(moved.ok, true)
  assert.equal(moved.switched, true)
  assert.deepEqual({ ...moved.active }, { name: 'work', provider: 'gemini' })
  const same = await switchAccount({ name: 'school', provider: 'codex' }, scope)
  assert.equal(same.ok, true)
  assert.equal(same.switched, false, 'ok:true with switched:false is "already using", not a switch')
  assert.deepEqual(sent, [{ name: 'work', provider: 'gemini' }, { name: 'school', provider: 'codex' }])
  const vague = await switchAccount({ name: 'work', provider: 'gemini' }, fakeScope({ accountSwitch: async () => ({ ok: true, switched: 'yes', active: { name: 'work', provider: 'copilot' } }) }))
  assert.equal(vague.switched, false, 'switched is true only for the boolean true')
  assert.equal(vague.active, null, 'an active record with an unknown provider is not carried')
})

test('addManagedAccount sends the provider and the optional name, and answers the name the shell settled on', async () => {
  const sent = []
  const scope = fakeScope({
    accountAddManaged: async request => {
      sent.push(request)
      return { ok: true, name: request.name || 'codex-2', provider: request.provider, directory: '.codex-managed-2' }
    },
  })
  const named = await addManagedAccount({ provider: 'codex', name: 'work' }, scope)
  assert.deepEqual({ ...named }, { ok: true, code: null, name: 'work', provider: 'codex', reason: null })
  const unnamed = await addManagedAccount({ provider: 'claude' }, scope)
  assert.equal(unnamed.name, 'codex-2', 'the shell chose the name, so the sign-in is opened for that one')
  assert.equal(unnamed.provider, 'claude')
  assert.deepEqual(sent, [{ provider: 'codex', name: 'work' }, { provider: 'claude' }])
  assert.equal('directory' in named, false, 'the folder the shell chose is its own business; the menu never shows or asks for one')
  const nameless = await addManagedAccount({ provider: 'gemini' }, fakeScope({ accountAddManaged: async () => ({ ok: true }) }))
  assert.equal(nameless.ok, false, 'an ok answer that names no account is not an account the sign-in can be opened for')
  assert.equal(nameless.reason, COPY.addRefused)
})

test('signInAccount forwards name and provider and answers ok only for ok:true', async () => {
  const sent = []
  const scope = fakeScope({ accountSignIn: async request => { sent.push(request); return { ok: true } } })
  const answer = await signInAccount({ name: 'school', provider: 'claude' }, scope)
  assert.deepEqual({ ...answer }, { ok: true, code: null, title: null, reason: null })
  assert.deepEqual(sent, [{ name: 'school', provider: 'claude' }])

  /* THE WINDOW'S OWN NAME, CARRIED THROUGH AND BOUNDED. It is the shell that
     decides what a sign-in window is called (shell/provider-login.cjs
     signInWindowTitle); this side quotes it rather than building a second copy
     of the format, so the sentence can never name a window something other than
     what is on it. A shell too old to answer one leaves it null above, which is
     a different answer from a window with no name and reads as one. */
  const titled = await signInAccount({ name: 'school', provider: 'claude' },
    fakeScope({ accountSignIn: async () => ({ ok: true, terminal: 'command-prompt', title: 'ToolsEnabled sign-in: school - claude' }) }))
  assert.equal(titled.title, 'ToolsEnabled sign-in: school - claude')
  const shouted = await signInAccount({ name: 'school', provider: 'claude' },
    fakeScope({ accountSignIn: async () => ({ ok: true, title: 'x'.repeat(400) }) }))
  assert.equal(shouted.title.length, 120, 'a title from the shell is not bounded before it reaches a sentence')
  const refused = await signInAccount({ name: 'school', provider: 'claude' }, fakeScope({ accountSignIn: async () => ({ ok: false, code: 'PROVIDER_NOT_INSTALLED', reason: 'Claude is not installed on this computer. Install it, then press Sign in again.' }) }))
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'PROVIDER_NOT_INSTALLED')
  assert.ok(refused.reason.startsWith('Claude is not installed'))
})

test('the bridge module carries no credential field and no way to send one', () => {
  /* The wrappers move names, providers, statuses and percentages. A field
     shaped like a secret on any of their requests would be the one thing the
     header says never happens. */
  const requests = [
    { name: 'school', provider: 'codex' },
    { provider: 'codex', name: 'work' },
    { selectionMode: 'even', reservePercent: 25 },
  ]
  for (const request of requests) {
    for (const key of Object.keys(request)) {
      assert.ok(!/(?:password|credential|token|secret|key|api)/i.test(key), `${key} is a credential-shaped request field`)
    }
  }
})

/* ------------------------------ the words ------------------------------ */

const SIGN_IN_TITLE = 'ToolsEnabled sign-in: work - codex'

const SAMPLE_ARGS = Object.freeze({
  roomLeft: [82], percentFree: [82], switched: ['work'], switchedRanked: ['work', 'Dynamic'], switchedAlready: ['work'],
  modeSaved: ['Dynamic'], added: ['work', SIGN_IN_TITLE], addedOnly: ['work'],
  signInOpened: ['work', SIGN_IN_TITLE], openingSignIn: ['work'], signInEach: [2],
  notInstalled: ['Gemini'], orderFor: ['Codex', 'work has the most left.'],
})

function everyCopySentence() {
  const sentences = []
  for (const [key, value] of Object.entries(COPY)) {
    const text = typeof value === 'function' ? value(...(SAMPLE_ARGS[key] || ['x'])) : value
    assert.equal(typeof text, 'string', `COPY.${key} does not resolve to a string`)
    sentences.push([key, text])
  }
  return sentences
}

test('every COPY entry is a string or a function of its arguments, and every sentence is under 25 words', () => {
  const sentences = everyCopySentence()
  assert.ok(sentences.length >= 40, `only ${sentences.length} copy entries were found; the table has shrunk`)
  for (const [key, text] of sentences) {
    assert.ok(text.trim().length > 0, `COPY.${key} is empty`)
    for (const sentence of text.split(/(?<=[.!?…])\s+/)) {
      const words = (sentence.match(/\S+/g) || []).length
      assert.ok(words <= 25, `COPY.${key} has a ${words}-word sentence: ${sentence}`)
    }
  }
})

test('no word on the menu calls the five-hour window an hour', () => {
  for (const [key, text] of everyCopySentence()) {
    assert.ok(!/\bthis hour\b/i.test(text), `COPY.${key} says "this hour": ${text}`)
    assert.ok(!/\bhourly\b/i.test(text), `COPY.${key} says "hourly": ${text}`)
  }
  for (const choice of SELECTION_MODE_CHOICES) {
    assert.ok(!/\bhourly\b|\bthis hour\b/i.test(choice.help), `${choice.id} help calls the window an hour: ${choice.help}`)
  }
})

test('the sentences that point at a button name the button as it is labelled', () => {
  /* "then press Check allowances" has to match the button, or a person is told
     to press something that is not on the screen. */
  for (const key of ['added', 'signInOpened']) {
    assert.ok(COPY[key]('work', SIGN_IN_TITLE).includes(COPY.refresh), `COPY.${key} names a button other than “${COPY.refresh}”`)
  }
  assert.ok(COPY.signInRefused.includes(COPY.signIn), 'signInRefused sends the person to a button by a name the row does not use')
  assert.ok(COPY.added('work', SIGN_IN_TITLE).includes('“work”'), 'the add confirmation names the account that was added')
})

test('the sign-in sentences say what a person will actually see, and name the window they will see it in', () => {
  /* THE DEFECT THESE CLOSE. "A sign-in window opened for “work”" named neither
     of the two places the sign-in happens -- a terminal window AND the browser
     that window sends you to -- and gave nobody a way to pick the right one out
     of several, because every sign-in window ran the same command and, until
     2026-09-03, every one of them was untitled. */
  const opened = COPY.signInOpened('work', SIGN_IN_TITLE)
  assert.ok(opened.includes(`“${SIGN_IN_TITLE}”`), `the sentence does not name the window: ${opened}`)
  assert.ok(/terminal window/i.test(opened), `the sentence does not say a terminal window opened: ${opened}`)
  assert.ok(/browser/i.test(opened), `the sentence does not say the sign-in also goes to the browser: ${opened}`)

  /* A SHELL THAT ANSWERED NO TITLE IS A DIFFERENT ANSWER, and it is not merged
     with the other: the account is still named, and no window name is invented
     for a window this side was never told the name of. */
  const untitled = COPY.signInOpened('work', null)
  assert.ok(untitled.includes('“work”'), `the untitled sentence does not name the account: ${untitled}`)
  assert.ok(!untitled.includes('undefined') && !untitled.includes('null'),
    `the untitled sentence prints a missing value at the person: ${untitled}`)
  assert.ok(/terminal window/i.test(untitled) && /browser/i.test(untitled),
    `the untitled sentence stopped saying what the person will see: ${untitled}`)

  /* The progress line names the account too, because the run below says it
     several times over and "Opening the sign-in window…" three times running
     tells a person nothing about which window is arriving. */
  assert.ok(COPY.openingSignIn('work').includes('“work”'), 'the progress line does not name the account')
  /* And the add help describes the same two places, so the sentence before the
     press and the sentence after it cannot describe different products. */
  assert.ok(/terminal window/i.test(COPY.addHelp) && /browser/i.test(COPY.addHelp),
    `the add help does not say what a person will see: ${COPY.addHelp}`)
})

test('the one control for several sign-ins says how many are left and that they come one at a time', () => {
  /* The label is the only warning against the thing the person is afraid of:
     six windows at once is the state this control exists to avoid, so it says
     what a press does rather than leaving it to be discovered. */
  assert.equal(COPY.signInEach(3), 'Sign in the 3 that need it, one window at a time')
  assert.match(COPY.signInEach(3), /one window at a time/)
  assert.equal(COPY.signInEach(1), 'Sign in the last one that needs it',
    'the label reads as broken English when one account is left')
  assert.equal(COPY.signInEachDone, 'That was the last one that needed it.')
})

test('the switch confirmations say what the engine does under each kind of mode', () => {
  assert.equal(COPY.switched('work'), 'Now using “work”. The next run starts on it.')
  assert.equal(COPY.switchedRanked('work', 'Most room left first'),
    'Now using “work”. The next run starts on it; after that, “Most room left first” picks.')
  assert.equal(COPY.switchedAlready('work'), 'Already using “work”. Nothing changed.')
  assert.equal(COPY.added('work', SIGN_IN_TITLE),
    'Added “work”. A terminal window named “ToolsEnabled sign-in: work - codex” opened. '
    + 'Sign in there and in your browser, then press Check allowances.')
  assert.equal(COPY.reserveInvalid, 'Type a number from 0 to 100.')
})

test('the words the DOM module used to keep to itself are in COPY now', () => {
  /* Findings 30 and 57: six strings were written inside render code, where
     no gate could see them. Each has a key here. */
  for (const key of ['notKnown', 'notSignedIn', 'signInUnchecked', 'saving', 'switching', 'adding', 'openingSignIn', 'signIn', 'reserveUnit', 'roomLeft', 'percentFree', 'checked']) {
    assert.ok(key in COPY, `COPY.${key} is missing`)
  }
})

test('a check that announces its start announces its end', () => {
  /* Measured on the second review: on success the status line was cleared,
     which hid it, so a screen reader heard "Checking…" and then nothing. */
  assert.equal(COPY.checked, 'Checked. The bars show what each account reported.')
  assert.ok(COPY.checked.startsWith('Checked.'), 'the completion sentence has to answer the progress word')
  assert.notEqual(COPY.checked, COPY.refreshing)
})

/* ------------------------------ signing several in ------------------------------ */

test('the sign-in run offers the rows that need it, in list order, and never the same one twice', () => {
  /* THE DEFECT. Signing in finishes in the person's own window, which this
     product reads nothing of, so an account whose window is open still reads
     "not signed in" until they are done. A run recomputed from the list alone
     would therefore offer the same account for ever and never reach the second
     one -- which is exactly the two-accounts-to-sign-in case this exists for. */
  const accounts = [
    { name: 'school', provider: 'codex', signedIn: true, status: 'HEALTHY', canServe: true },
    { name: 'work', provider: 'codex', signedIn: false, status: null, canServe: null },
    { name: 'home', provider: 'claude', signedIn: null, status: 'signed_out', canServe: false },
    { name: 'lab', provider: 'claude', signedIn: null, status: null, canServe: null },
  ]
  assert.deepEqual(signInQueue(accounts).map(account => account.name), ['work', 'home'],
    'the run offers a row nothing has checked, or misses one the engine called signed out')

  /* One window opened: that account leaves the queue and the next is offered,
     even though the list still says it is not signed in. */
  const opened = new Set([accountKey({ provider: 'codex', name: 'work' })])
  assert.deepEqual(signInQueue(accounts, opened).map(account => account.name), ['home'])
  opened.add(accountKey({ provider: 'claude', name: 'home' }))
  assert.deepEqual(signInQueue(accounts, opened), [], 'the run never ends')

  /* THE PROGRAM IS HALF THE KEY. Names are unique per program and not across
     them, so a Codex "work" that has been opened must not take a Claude "work"
     out of the queue with it. */
  const twoPrograms = [
    { name: 'work', provider: 'codex', signedIn: false, status: null, canServe: null },
    { name: 'work', provider: 'claude', signedIn: false, status: null, canServe: null },
  ]
  const codexDone = new Set([accountKey({ provider: 'codex', name: 'work' })])
  assert.deepEqual(signInQueue(twoPrograms, codexDone).map(account => account.provider), ['claude'])
  /* And a name is matched the way every other name on this surface is matched. */
  assert.equal(accountKey({ provider: 'codex', name: 'Work' }), accountKey({ provider: 'codex', name: 'work' }))
})

/* ------------------------------ one fact, one flag ------------------------------ */

test('a row the shell and the engine both call signed out carries one flag, and offers Sign in', () => {
  /* Measured on the first live drive: after Check allowances a row read "not
     signed in signed out" -- the shell's word beside the engine's, for one
     fact. */
  const both = { signedIn: false, status: 'signed_out', canServe: false, reason: 'This Claude home is not signed in. Sign in to it with CLAUDE_CONFIG_DIR set to its directory.' }
  const flags = rowFlags(both)
  assert.equal(flags.length, 1, 'one fact drew two flags')
  assert.equal(flags[0].text, COPY.notSignedIn)
  assert.equal(flags[0].tone, 'bad')
  /* The engine's sign-out sentence tells a person to set an environment
     variable by hand, beside a row that already offers Sign in; it is not
     repeated, in the tooltip or anywhere else on the row. */
  assert.equal(flags[0].title, null, 'the engine sign-out reason is back in the tooltip')
  assert.ok(!rowLines(both).some(line => line.text === both.reason), 'the engine sign-out reason is printed under the row')
  assert.equal(needsSignIn(both), true)
  /* The engine looked and the shell did not say: still one flag, still a Sign in. */
  const engineOnly = { signedIn: null, status: 'SIGNED_OUT', canServe: false, reason: null }
  assert.deepEqual(rowFlags(engineOnly).map(flag => flag.text), [COPY.notSignedIn])
  assert.equal(needsSignIn(engineOnly), true)
  /* The shell says no and the engine has not been asked: the plain flag, no tooltip. */
  const shellOnly = { signedIn: false, status: null, canServe: null, reason: null }
  assert.deepEqual(rowFlags(shellOnly), [{ text: COPY.notSignedIn, tone: 'plain', title: null }])
  assert.equal(needsSignIn(shellOnly), true)
  /* Unchecked by the shell, unsaid by the engine: the second flag, and no Sign in. */
  assert.deepEqual(rowFlags({ signedIn: null, status: null, canServe: null }).map(flag => flag.text), [COPY.signInUnchecked])
  assert.equal(needsSignIn({ signedIn: null, status: null, canServe: null }), false)
  /* A different engine fact beside the shell's is two facts, and two flags. */
  const two = rowFlags({ signedIn: false, status: 'NOT_PROVISIONED', canServe: false, reason: 'no folder' })
  assert.deepEqual(two.map(flag => flag.text), [COPY.notSignedIn, 'not provisioned'])
  assert.equal(two[1].tone, 'bad')
  assert.equal(two[1].title, 'no folder')
  /* Signed in and healthy: no flag at all, and no Sign in. */
  assert.deepEqual(rowFlags({ signedIn: true, status: 'HEALTHY', canServe: true }), [])
  assert.equal(needsSignIn({ signedIn: true, status: 'HEALTHY', canServe: true }), false)
  /* A signed-out word from an engine that still says the account can serve is
     not a verdict: canServe is the engine's own. */
  assert.deepEqual(rowFlags({ signedIn: true, status: 'signed_out', canServe: true }), [])
  assert.equal(needsSignIn({ signedIn: true, status: 'signed_out', canServe: true }), false)
  /* The merge output feeds it directly: a merged, unmeasured, signed-out row. */
  const merged = mergeAccounts(readAccountList(LIST_REPLY), readUsageReply({
    ok: true,
    accounts: [{ name: 'school', provider: 'codex', allowanceBinding: FIXTURE_BINDINGS.codexSchool, status: 'signed_out', canServe: false, reason: 'no sign-in' }],
    orders: [],
  }))
  const school = merged.find(account => account.name === 'school' && account.provider === 'codex')
  assert.deepEqual(rowFlags(school), [{ text: COPY.notSignedIn, tone: 'bad', title: null }])
  assert.deepEqual(rowLines(school).map(line => line.text), [COPY.usageUnknown, COPY.usageUnknownWhy],
    'a signed-out Codex row keeps its two allowance lines and gains no engine sentence')
})

/* ------------------------------ the lines under a row ------------------------------ */

test('a program nobody measures gets one sentence under its row, not "not known" twice', () => {
  /* Measured on the second review: every Gemini row read "How much is left is
     not known for this account." and then "This copy does not measure how
     much a Gemini account has left, so it stays not known." -- one fact in
     two sentences. */
  const rows = mergeAccounts(readAccountList(LIST_REPLY), null)
  const gemini = rows.find(row => row.provider === 'gemini')
  assert.deepEqual(rowLines(gemini).map(line => [line.text, line.quiet]), [[COPY.usageNotMeasured, false]])
  assert.equal(Object.isFrozen(rowLines(gemini)), true)
  /* A measured-provider row nothing has read keeps its two lines. */
  const codex = rows.find(row => row.provider === 'codex')
  assert.deepEqual(rowLines(codex).map(line => [line.text, line.quiet]), [[COPY.usageUnknown, false], [COPY.usageUnknownWhy, true]])
  /* A measured row says its figures and nothing else. */
  const measured = mergeAccounts(readAccountList(LIST_REPLY), readUsageReply({
    ok: true,
    accounts: [{ name: 'school', provider: 'codex', allowanceBinding: FIXTURE_BINDINGS.codexSchool, status: 'HEALTHY', canServe: true, windows: { hourly: { usedPercent: 18, resetsAt: inMs(4 * HOUR) } } }],
  })).find(row => row.provider === 'codex')
  assert.deepEqual(rowLines(measured, { now: NOW }).map(line => line.text), ['82% free this 5-hour window · resets in 4h'])
  /* A Gemini row the engine did measure is a measured row, whatever the table says. */
  const measuredGemini = mergeAccounts(readAccountList(LIST_REPLY), readUsageReply({
    ok: true,
    accounts: [{ name: 'work', provider: 'gemini', allowanceBinding: FIXTURE_BINDINGS.geminiWork, status: 'HEALTHY', canServe: true, windows: { weekly: { usedPercent: 50 } } }],
  })).find(row => row.provider === 'gemini')
  assert.deepEqual(rowLines(measuredGemini).map(line => line.text), ['50% free this week'])
})

test('an engine fault other than signed out is read in the tooltip and under the row; a sign-out is not', () => {
  /* Measured on the second review: the engine's reason rode only in a span's
     title, which a keyboard never reaches. For every status but signed_out
     it is now a visible quiet line as well; for signed_out it is dropped,
     because the flag and the Sign in button already say everything a person
     can do, and the engine's sentence names an environment variable. */
  const rows = mergeAccounts(readAccountList(LIST_REPLY), readUsageReply({
    ok: true,
    accounts: [
      { name: 'school', provider: 'codex', allowanceBinding: FIXTURE_BINDINGS.codexSchool, status: 'EXHAUSTED', canServe: false, reason: 'Its weekly allowance is used up. It resets on Monday.' },
      { name: 'school', provider: 'claude', allowanceBinding: FIXTURE_BINDINGS.claudeSchool, status: 'signed_out', canServe: false, reason: 'This Claude home is not signed in. Sign in to it with CLAUDE_CONFIG_DIR set to its directory.' },
      { name: 'work', provider: 'gemini', allowanceBinding: FIXTURE_BINDINGS.geminiWork, status: 'NOT_PROVISIONED', canServe: false },
    ],
  }))
  const codex = rows.find(row => row.provider === 'codex')
  assert.deepEqual(rowFlags(codex), [{ text: 'exhausted', tone: 'bad', title: 'Its weekly allowance is used up. It resets on Monday.' }])
  assert.deepEqual(rowLines(codex).map(line => [line.text, line.quiet]), [
    [COPY.usageUnknown, false],
    [COPY.usageUnknownWhy, true],
    ['Its weekly allowance is used up. It resets on Monday.', true],
  ])
  const claude = rows.find(row => row.provider === 'claude')
  assert.deepEqual(rowFlags(claude), [{ text: COPY.notSignedIn, tone: 'bad', title: null }])
  assert.ok(!rowLines(claude).some(line => /CLAUDE_CONFIG_DIR/.test(line.text)), 'the environment-variable sentence reached the row')
  /* A fault with no reason draws the flag and no extra line; the shell's
     unchecked sign-in still draws its own flag beside it. */
  const gemini = rows.find(row => row.provider === 'gemini')
  assert.deepEqual(rowFlags(gemini), [
    { text: COPY.signInUnchecked, tone: 'plain', title: null },
    { text: 'not provisioned', tone: 'bad', title: null },
  ])
  assert.deepEqual(rowLines(gemini).map(line => line.text), [COPY.usageNotMeasured])
})


/* ------------------------------ the spent row ------------------------------ */

/* WHAT AN EXHAUSTED ROW SAYS, AND WHO SAYS THE CLOCK.
 *
 * MEASURED 2026-09-03 in the installed copy's own accounts-usage-cache.json
 * (%APPDATA%/ToolsEnabled-Live), which is the very reply this module reads:
 * the exhausted Claude row's sentence was
 *
 *   "The account surface reports a signed-in session, but no request was made,
 *    so it is not proven able to serve one. Re-run with capability checking
 *    enabled to resolve this. 92% of its weekly allowance is used; resets
 *    2026-09-03T17:00:00.309845+00:00."
 *
 * -- advice written for a probe run from a command line, plus a microsecond
 * ISO timestamp, printed under a row already flagged "exhausted". The engine
 * now sends the plain sentence and the reset time as a FIELD. These two tests
 * are the menu's half of that: it turns the field into words with its own
 * resetPhrase(), and it does not repeat a clause a window already carries. */
test('an exhausted row says why in plain words, and no machine value reaches the screen', () => {
  const spent = mergeAccounts(readAccountList(LIST_REPLY), readUsageReply({
    ok: true,
    accounts: [{
      name: 'school', provider: 'codex', allowanceBinding: FIXTURE_BINDINGS.codexSchool, status: 'exhausted', canServe: false,
      reason: 'Signed in, but this account is out of allowance for now, so it is not being started. 92% of its weekly allowance is used.',
      resetsAt: inMs(11 * HOUR),
      windows: { hourly: { usedPercent: 0 }, weekly: { usedPercent: 92, resetsAt: inMs(11 * HOUR) } },
    }],
  })).find(row => row.provider === 'codex')

  const lines = rowLines(spent, { now: NOW }).map(line => line.text)
  assert.deepEqual(lines, [
    '100% free this 5-hour window · 8% free this week · resets in 11h',
    'Signed in, but this account is out of allowance for now, so it is not being started. 92% of its weekly allowance is used.',
  ])
  /* The window's own line already said when it comes back, so the fault line
     does not say it again: "one fact, said twice, in two vocabularies" is the
     defect this file has recorded twice before. */
  assert.equal(lines.filter(text => text.includes('resets in 11h')).length, 1)
  assert.ok(!lines.some(text => /\d{4}-\d{2}-\d{2}T/.test(text)),
    'a raw timestamp is back on a screen a person reads')
  /* And the tooltip beside the name is the SAME sentence, so a pointer and a
     screen reader are not told two different things about one row. */
  assert.deepEqual(rowFlags(spent, { now: NOW }).map(flag => [flag.text, flag.title]), [
    ['exhausted', 'Signed in, but this account is out of allowance for now, so it is not being started. 92% of its weekly allowance is used.'],
  ])
})

test('a row the engine timed but measured no window for gets its reset clause from the menu, in words', () => {
  const REASON = "The provider reports this account's rate limit reached (weekly)."
  const limited = mergeAccounts(readAccountList(LIST_REPLY), readUsageReply({
    ok: true,
    accounts: [{ name: 'school', provider: 'codex', allowanceBinding: FIXTURE_BINDINGS.codexSchool, status: 'exhausted', canServe: false, reason: REASON, resetsAt: inMs(3 * HOUR) }],
  })).find(row => row.provider === 'codex')

  /* This is the case that has nowhere else to say it: no window was measured,
     so no line above carries the clock. The menu adds one, from resetPhrase. */
  assert.deepEqual(rowLines(limited, { now: NOW }).map(line => line.text), [
    COPY.usageUnknown,
    COPY.usageUnknownWhy,
    `${REASON} Resets in 3h.`,
  ])
  // A reset already in the past is a real state, and still not a timestamp.
  assert.equal(faultLine({ ...limited, resetsAt: inMs(-HOUR) }, { now: NOW }), `${REASON} Due to reset.`)
  // Nothing said, nothing invented -- for an absent time and an unreadable one.
  assert.equal(faultLine({ ...limited, resetsAt: null }, { now: NOW }), REASON)
  assert.equal(faultLine({ ...limited, resetsAt: 'not a time' }, { now: NOW }), REASON)
  // A row with no fault has no line at all, and gains no clause.
  assert.equal(faultLine({ signedIn: true, status: 'HEALTHY', canServe: true, resetsAt: inMs(3 * HOUR) }, { now: NOW }), '')
  /* A signed-out row keeps its own treatment: the engine's sign-out sentence
     is dropped, so there is nothing for a clause to attach to. */
  assert.equal(faultLine({ signedIn: false, status: 'signed_out', canServe: false, reason: 'sign in again', resetsAt: inMs(3 * HOUR) }, { now: NOW }), '')
})

/* WHICH ACCOUNT A ROW IS ACTUALLY SIGNED IN AS.
 *
 * WHAT THIS GUARDS. The engine has always reported the address each program
 * answers with, and readUsageReply threw it away, so a row labelled "school"
 * over a home signed in as somebody else looked exactly like a row that was
 * right. Nothing in this product sees which account a person picks in the
 * browser after pressing Sign in, so this line is the only thing that can make
 * a wrong one visible.
 *
 * IT IS THREE FACTS AND THEY MUST STAY APART: an address that was reported (say
 * it), an address that was not (say nothing -- never the row's own name, which
 * would make every row agree with itself), and a mismatch the engine refused
 * (the address AND the engine's sentence, in that order). */
test('a row says which sign-in the program answered with, quietly, and says nothing when none was answered', () => {
  const rows = mergeAccounts(readAccountList(LIST_REPLY), readUsageReply({
    ok: true,
    accounts: [
      {
        name: 'school', provider: 'codex', allowanceBinding: FIXTURE_BINDINGS.codexSchool, status: 'HEALTHY', canServe: true, email: 'school@example.test',
        windows: { hourly: { usedPercent: 18, resetsAt: inMs(4 * HOUR) } },
      },
      { name: 'school', provider: 'claude', allowanceBinding: FIXTURE_BINDINGS.claudeSchool, status: 'HEALTHY', canServe: true },
    ],
  }))
  const codex = rows.find(row => row.provider === 'codex')
  assert.equal(codex.email, 'school@example.test')
  assert.deepEqual(rowLines(codex, { now: NOW }).map(line => [line.text, line.quiet]), [
    ['82% free this 5-hour window · resets in 4h', false],
    ['Signed in as school@example.test.', true],
  ], 'the identity line is missing, loud, or in front of the allowance')

  /* Reported nothing: no line, and above all not the row's own name. */
  const claude = rows.find(row => row.provider === 'claude')
  assert.equal(claude.email, null)
  assert.ok(!rowLines(claude).some(line => /Signed in as/.test(line.text)),
    'a row nothing reported an address for still claimed to know one')
  assert.ok(!rowLines(claude).some(line => /school/.test(line.text)),
    'the row filled its identity line in from its own label')

  /* A reply this build does not recognise cannot become an address. */
  for (const junk of [42, null, '', {}, ['a@b.test']]) {
    const [row] = mergeAccounts(readAccountList(LIST_REPLY), readUsageReply({
      ok: true, accounts: [{ name: 'school', provider: 'codex', allowanceBinding: FIXTURE_BINDINGS.codexSchool, status: 'HEALTHY', canServe: true, email: junk }],
    }))
    assert.equal(row.email, null, `${JSON.stringify(junk)} was read as an address`)
  }
})

test('a refused identity shows the address that is there and the engine\'s sentence with it', () => {
  /* The shape rotation.js's claudeIdentityFault produces: the account cannot
     serve, the status is the engine's own word for it, and the reason names the
     address actually signed in. Both reach the row -- the quiet identity line
     so it is visible at a glance, the engine's sentence so a person knows what
     to do -- and the flag carries the status word. */
  const [row] = mergeAccounts(readAccountList(LIST_REPLY), readUsageReply({
    ok: true,
    accounts: [{
      name: 'school', provider: 'codex', allowanceBinding: FIXTURE_BINDINGS.codexSchool, status: 'account_mismatch', canServe: false,
      email: 'someone.else@example.test',
      reason: '"school" is signed in as someone.else@example.test, which is not the account it expects. Sign that row in again as the account it expects, or remove it and add it back.',
    }],
  }))
  assert.deepEqual(rowFlags(row).map(flag => flag.text), ['account mismatch'])
  const lines = rowLines(row).map(line => [line.text, line.quiet])
  assert.deepEqual(lines[0], [COPY.usageUnknown, false])
  assert.deepEqual(lines[1], [COPY.usageUnknownWhy, true])
  assert.deepEqual(lines[2], ['Signed in as someone.else@example.test.', true])
  assert.match(lines[3][0], /not the account it expects/)
  assert.equal(lines.length, 4)
})

/* ------------------------------ why this order ------------------------------ */

test('the order paragraph says a shared sentence once, and names the program when the sentences differ', () => {
  /* Measured on the first live drive: with a Claude and a Gemini account and
     nothing measured, the same sentence was printed twice, once per program. */
  const unread = 'No account reported how much of its allowance is left, so the listed order was used.'
  assert.equal(orderExplanation([{ provider: 'claude', names: [], why: unread }, { provider: 'gemini', names: [], why: unread }]), unread)
  assert.equal(orderExplanation([{ provider: 'codex', names: ['work'], why: '“work” has the most left.' }]), '“work” has the most left.')
  assert.equal(
    orderExplanation([{ provider: 'codex', names: ['work'], why: '“work” has the most left.' }, { provider: 'claude', names: [], why: unread }]),
    `Codex: “work” has the most left. Claude: ${unread}`)
  /* Two measured programs, two sentences: each is named for its program. The
     Gemini order beside them is dropped, not named: this copy never measures
     a Gemini allowance, so "no account reported" is not news about Gemini. */
  assert.equal(
    orderExplanation([{ provider: 'codex', names: [], why: unread }, { provider: 'claude', names: ['a'], why: '“a” goes first.' }, { provider: 'gemini', names: [], why: unread }]),
    `Codex: ${unread} Claude: “a” goes first.`)
  assert.equal(orderExplanation([{ provider: 'gemini', names: [], why: unread }]), '', 'a Gemini order alone explains nothing')
  assert.equal(orderExplanation([{ provider: 'gemini', names: [], why: unread }, { provider: 'claude', names: [], why: unread }]), unread,
    'a sentence shared with a dropped program is not named for a program')
  assert.equal(orderExplanation([]), '')
  assert.equal(orderExplanation([{ provider: 'codex', names: [], why: null }, { provider: 'claude' }, 'x', null]), '')
  assert.equal(orderExplanation(undefined), '')
  /* The normalised reply feeds it directly. */
  const usage = readUsageReply({ ok: true, accounts: [], orders: [{ provider: 'codex', names: [], why: unread }, { provider: 'claude', names: [], why: unread }] })
  assert.equal(orderExplanation(usage.orders), unread)
})

test('the order paragraph is empty under the two modes whose order is the list, and under a failed read', () => {
  /* Measured on the second review: the engine answers "In the order the
     accounts are listed." for manual and priority, and the first draft
     printed it under the list -- filler under rows that already show it. */
  const listed = 'In the order the accounts are listed.'
  const usage = readUsageReply({ ok: true, accounts: [], orders: [{ provider: 'codex', names: ['school'], why: listed }] })
  assert.equal(orderParagraph('manual', usage), '')
  assert.equal(orderParagraph('priority', usage), '')
  for (const mode of RANKED_MODE_IDS) assert.equal(orderParagraph(mode, usage), listed, `${mode} ranks, so its order needs words`)
  assert.equal(orderParagraph('even', readUsageReply(null)), '', 'a failed read has no order to explain')
  assert.equal(orderParagraph('even', null), '')
  assert.equal(orderParagraph('even', undefined), '')
  assert.equal(orderParagraph(undefined, usage), '', 'an unknown mode is manual, and manual explains nothing')
})

/* --------------------- the choice, and what moved off it -------------------- */

/* A shell that answers the choice and the failover that moved off it. MEASURED
   2026-09-03 on a real machine: the account chosen by hand was 92% through
   a week that did not reset for another three hours, the start used the other
   account, and this menu showed only that other account, "In use now", with
   nothing anywhere saying a choice had been made. Account names below are
   placeholder handles, not a real sign-in. */
const MOVED_OFF_REPLY = Object.freeze({
  ok: true,
  accounts: [
    { name: 'acct-primary', provider: 'claude', directory: '.claude-a', priority: 1, signedIn: 'yes' },
    { name: 'acct-active', provider: 'claude', directory: '.claude-b', priority: 2, signedIn: 'yes' },
  ],
  active: {
    name: 'acct-active', provider: 'claude', at: '2026-09-03T13:18:24.143Z',
    chosenByProvider: { codex: null, claude: 'acct-primary', gemini: null },
    movedOffByProvider: {
      codex: null, gemini: null,
      claude: {
        chosen: 'acct-primary', using: 'acct-active', at: '2026-09-03T13:18:24.143Z',
        reason: '92% of its weekly allowance is used; resets 2026-09-03T16:59:59Z.',
      },
    },
  },
  activeByProvider: { codex: null, claude: 'acct-active', gemini: null },
  policy: { selectionMode: 'priority', recorded: true },
})

test('the menu says which account was chosen, that the computer is on another, and why', () => {
  const list = readAccountList(MOVED_OFF_REPLY)
  assert.deepEqual(list.chosenByProvider, { codex: null, claude: 'acct-primary', gemini: null, grok: null })

  const said = movedOffParagraph(list)
  assert.match(said, /“acct-primary” is the account you chose/)
  assert.match(said, /on “acct-active” for now/)
  assert.match(said, /returns to “acct-primary” once it can serve/)
  assert.match(said, /92% of its weekly allowance is used; resets 2026-09-03T16:59:59Z\./,
    'the figure and the reset are the two facts a person acts on, and they were dropped')

  /* THE ROW SAYS IT TOO, because a paragraph under the list does not tell a
     person WHICH row is theirs. */
  const rows = mergeAccounts(list, null)
  const chosen = rows.find(row => row.name === 'acct-primary')
  const running = rows.find(row => row.name === 'acct-active')
  assert.equal(chosen.chosen, true)
  assert.equal(chosen.active, false, 'control: the chosen row is not the row in use')
  assert.equal(running.active, true)
  assert.equal(running.chosen, false)
})

test('the paragraph is empty when nothing moved off a choice, and for a shell that does not answer', () => {
  /* "This build cannot say" must not draw as "nothing happened" -- it draws as
     nothing at all, which is what the rest of this menu does with an absent
     optional read. */
  assert.equal(movedOffParagraph(readAccountList(LIST_REPLY)), '')
  assert.equal(readAccountList(LIST_REPLY).chosenByProvider, null, 'a shell that does not say is null, not a table of nulls')
  assert.equal(readAccountList(LIST_REPLY).movedOffByProvider, null)
  assert.equal(movedOffParagraph(null), '')
  assert.equal(movedOffParagraph({}), '')

  // On the choice, so nothing to explain.
  const settled = readAccountList({
    ...MOVED_OFF_REPLY,
    active: { ...MOVED_OFF_REPLY.active, movedOffByProvider: { codex: null, claude: null, gemini: null } },
  })
  assert.equal(movedOffParagraph(settled), '')
  assert.equal(settled.chosenByProvider.claude, 'acct-primary', 'the choice is still the choice')

  /* A row that cannot name what is running instead explains nothing, and a
     half-drawn sentence is worse than none. */
  const halfSaid = readAccountList({
    ...MOVED_OFF_REPLY,
    active: { ...MOVED_OFF_REPLY.active, movedOffByProvider: { codex: null, gemini: null, claude: { chosen: 'acct-primary' } } },
  })
  assert.equal(halfSaid.movedOffByProvider.claude, null)
  assert.equal(movedOffParagraph(halfSaid), '')
})

test('a start that never reached the chosen account is said without a reason it does not have', () => {
  /* "Could not look" and "not there" are different answers. */
  const noReason = readAccountList({
    ...MOVED_OFF_REPLY,
    active: {
      ...MOVED_OFF_REPLY.active,
      movedOffByProvider: { codex: null, gemini: null, claude: { chosen: 'acct-primary', using: 'acct-active', at: null, reason: null } },
    },
  })
  const said = movedOffParagraph(noReason)
  assert.match(said, /“acct-primary” is the account you chose/)
  assert.doesNotMatch(said, /Why:/, 'a reason nobody recorded was invented')
})

/* ------------------------------ not installed ------------------------------ */

test('a sign-in refused because the program is not installed says where Install is, in the words of this menu', async () => {
  /* Measured on the first live drive: adding a Gemini account on a computer
     without Gemini said "Press Install first, and this button will work."
     There is no Install button on this menu; it is in Settings, under
     "This computer". */
  const shellSentence = 'That program is not on this computer yet. Press Install first, and this button will work.'
  const scope = fakeScope({ accountSignIn: async () => ({ ok: false, code: NOT_INSTALLED_CODE, reason: shellSentence }) })
  const answer = await signInAccount({ name: 'qa-gemini', provider: 'gemini' }, scope)
  assert.equal(answer.ok, false)
  assert.equal(answer.code, NOT_INSTALLED_CODE, 'the code is kept so a caller can still tell this refusal apart')
  assert.equal(answer.reason, COPY.notInstalled('Gemini'))
  assert.ok(answer.reason.startsWith('Gemini '), 'the sentence names the program that is missing')
  assert.ok(answer.reason.includes('Settings, under "This computer"'), 'the sentence says where Install is')
  assert.ok(answer.reason.includes(COPY.signIn), 'the sentence names the press on this menu that follows the install')
  assert.ok(!answer.reason.includes('Press Install'), 'the sentence points at a button this menu does not have')
  /* Every other refusal still keeps the shell's own sentence. */
  const other = fakeScope({ accountSignIn: async () => ({ ok: false, code: 'PROVIDER_LOGIN_NO_TERMINAL', reason: 'No terminal.' }) })
  assert.equal((await signInAccount({ name: 'x', provider: 'codex' }, other)).reason, 'No terminal.')
  /* A request that named no known program still gets a sentence, not "unknown". */
  const nameless = await signInAccount({ name: 'x' }, scope)
  assert.equal(nameless.reason, COPY.notInstalled(COPY.programUnnamed))
  assert.ok(!/\bunknown\b/.test(nameless.reason))
})

test('no sentence on the menu presses a button the menu does not have', () => {
  /* The menu has no Install button; Settings, under "This computer", does. A
     sentence here that says "Press Install" sends a person looking for a control
     that is not on the screen in front of them. */
  for (const [key, text] of everyCopySentence()) {
    assert.ok(!/\bPress Install\b/.test(text), `COPY.${key} presses Install, which is in Settings under "This computer": ${text}`)
  }
})

/* ------------------------------ the kept read ------------------------------ */

test('readUsageReply carries the read time, and readAccountList hands the shell\'s kept read over in the same shape', () => {
  const reply = readUsageReply({ ok: true, readAt: '2026-09-02T12:00:00.000Z', accounts: [], orders: [] })
  assert.equal(reply.readAt, '2026-09-02T12:00:00.000Z')
  assert.equal(readUsageReply({ ok: true, accounts: [], orders: [] }).readAt, null, 'a reply that did not say is null')
  const cache = { ok: true, readAt: '2026-09-02T12:00:00.000Z', accounts: [{ name: 'a', provider: 'codex', allowanceBinding: 'a'.repeat(64), authGeneration: { kind: 'file', token: 'c'.repeat(64) }, status: 'HEALTHY', canServe: true, windows: { hourly: { usedPercent: 10 } } }], orders: [] }
  const list = readAccountList({ ok: true, accounts: [], usageCache: cache })
  assert.equal(list.cachedUsage.ok, true)
  assert.equal(list.cachedUsage.readAt, '2026-09-02T12:00:00.000Z')
  assert.equal(list.cachedUsage.readings['codex:a'].windows.hourly.usedPercent, 10)
  assert.equal(readAccountList({ ok: true, accounts: [] }).cachedUsage, null, 'no kept read is null, never an empty one')
  assert.equal(readAccountList({ ok: true, accounts: [], usageCache: 'nope' }).cachedUsage, null)
  for (const orders of ['damaged', {}, 1]) {
    const safe = readAccountList({ ok: true, accounts: [], usageCache: { ...cache, orders } })
    assert.equal(safe.available, true)
    assert.deepEqual(safe.cachedUsage.orders, [])
  }
  for (const authGeneration of [undefined, null, {}, { kind: 'file', token: 'invalid' }, { kind: 'unsupported', token: null }, { kind: 'absent', token: null }]) {
    const rejected = readAccountList({ ok: true, accounts: [], usageCache: { ...cache, accounts: [{ ...cache.accounts[0], authGeneration, fresh: true }] } })
    assert.equal(rejected.cachedUsage.readings['codex:a'], undefined, 'a malformed or non-file disk row gained explicit-read authority')
  }
})

test('an older disk cache without an account binding is discarded', () => {
  const list = readAccountList({ ok: true, accounts: [{ name: 'work', provider: 'codex', allowanceBinding: 'b'.repeat(64) }],
    usageCache: { ok: true, readAt: inMs(0), accounts: [{ name: 'work', provider: 'codex',
      email: 'old@example.test', windows: { hourly: { usedPercent: 0 } } }] } })
  assert.equal(list.cachedUsage, null)
  assert.equal(mergeAccounts(list, list.cachedUsage)[0].measured, false)
})

test('direct allowance replies without a valid positive identity binding stay unknown', () => {
  for (const allowanceBinding of [undefined, null, '', 'not-a-binding', 'a'.repeat(63), 'a'.repeat(65)]) {
    const list = readAccountList({ ok: true, accounts: [{ name: 'work', provider: 'codex', allowanceBinding }] })
    const usage = readUsageReply({ ok: true, readAt: inMs(0), accounts: [{ name: 'work', provider: 'codex',
      allowanceBinding, status: 'healthy', canServe: true, email: 'unverified@example.test',
      windows: { hourly: { usedPercent: 0 } } }] })
    const [row] = mergeAccounts(list, usage, { now: NOW })
    assert.equal(row.measured, false, `unverified binding ${String(allowanceBinding)} was trusted`)
    assert.equal(row.usageState, 'unknown')
    assert.equal(row.email, null)
    assert.equal(row.canServe, null)
    assert.equal(row.windows.hourly, null)
  }
})

test('each row uses its own original reading age and keeps weekly-only measured windows', () => {
  const list = readAccountList({ ok: true, accounts: [{ name: 'work', provider: 'claude', allowanceBinding: FIXTURE_BINDINGS.claudeWork }] })
  const usage = readUsageReply({ ok: true, readAt: inMs(0), accounts: [{ name: 'work', provider: 'claude', allowanceBinding: FIXTURE_BINDINGS.claudeWork,
    readAt: inMs(-10 * 60000), status: 'healthy', windows: { weeklyWindows: [{ usedPercent: 0 }] } }] })
  const [row] = mergeAccounts(list, usage, { now: NOW })
  assert.equal(row.measured, true)
  assert.equal(row.usageState, 'stale')
  assert.equal(row.usageReadAt, inMs(-10 * 60000))
})

test('an old allowance result cannot attach to a replacement account with the same label', () => {
  const list = readAccountList({ ok: true, accounts: [
    { provider: 'codex', name: 'work', directory: '/fixture/new-account', allowanceBinding: 'b'.repeat(64) },
  ] })
  const reply = { ok: true, readAt: inMs(0), accounts: [
    { provider: 'codex', name: 'work', allowanceBinding: 'a'.repeat(64), status: 'healthy',
      email: 'old@example.test', windows: { hourly: { usedPercent: 0 } } },
  ] }
  const [wrong] = mergeAccounts(list, readUsageReply(reply), { now: NOW })
  assert.equal(wrong.email, null)
  assert.equal(wrong.measured, false)
  reply.accounts[0].allowanceBinding = 'b'.repeat(64)
  const [right] = mergeAccounts(list, readUsageReply(reply), { now: NOW })
  assert.equal(right.email, 'old@example.test')
  assert.equal(right.windows.hourly.usedPercent, 0, 'measured zero was lost')
})

test('a failed allowance refresh keeps a matching prior reading with its original age', async () => {
  const previousUsage = readUsageReply({ ok: true, readAt: inMs(-10 * 60 * 1000), accounts: [
    { provider: 'codex', name: 'work', allowanceBinding: 'a'.repeat(64), authGeneration: { kind: 'file', token: 'c'.repeat(64) },
      status: 'healthy', windows: { hourly: { usedPercent: 0 } } },
  ] })
  const usage = await loadUsage({ mcProviders: { accounts() {}, accountUsage: async () => ({
    ok: false, reason: 'The provider did not answer.'
  }) } }, { previousUsage })
  assert.equal(usage.ok, false)
  assert.equal(usage.readAt, previousUsage.readAt)
  const [row] = mergeAccounts(readAccountList({ ok: true, accounts: [
    { provider: 'codex', name: 'work', allowanceBinding: 'a'.repeat(64), authGeneration: { kind: 'file', token: 'c'.repeat(64) } },
  ] }), usage, { now: NOW })
  assert.equal(row.windows.hourly.usedPercent, 0)
  assert.equal(row.usageState, 'failed')
  assert.equal(row.usageReadAt, previousUsage.readAt)
  assert.equal(row.usageError, 'The provider did not answer.')
})

test('a per-account usage refresh failure preserves only that same identity and the original reading age', async () => {
  const binding = 'a'.repeat(64)
  const authGeneration = { kind: 'file', token: 'c'.repeat(64) }
  const originalAt = inMs(-10 * 60000)
  const previousUsage = readUsageReply({ ok: true, readAt: originalAt, accounts: [
    { provider: 'claude', name: 'work', allowanceBinding: binding, authGeneration, status: 'healthy', email: 'work@example.test',
      readAt: originalAt, usageStatus: 'measured', windows: { weekly: { usedPercent: 27 } } },
  ] })
  const list = readAccountList({ ok: true, accounts: [{ provider: 'claude', name: 'work', allowanceBinding: binding, authGeneration }] })
  const failure = { provider: 'claude', name: 'work', allowanceBinding: binding, authGeneration, status: 'healthy', canServe: true,
    email: 'work@example.test', readAt: null, usageStatus: 'unavailable', usageReason: 'Claude could not check this allowance just now.',
    usageCode: 'CLAUDE_USAGE_TIMEOUT', windows: { hourly: null, weekly: null, weeklyWindows: [] } }
  const refresh = account => loadUsage({ mcProviders: { accounts() {}, accountUsage: async () => ({
    ok: true, readAt: inMs(0), accounts: [account]
  }) } }, { previousUsage })
  const usage = await refresh(failure)
  const [row] = mergeAccounts(list, usage, { now: NOW })
  assert.equal(row.status, 'healthy')
  assert.equal(row.canServe, true)
  assert.equal(row.windows.weekly?.usedPercent, 27, 'the last measurement disappeared because the batch itself succeeded')
  assert.equal(row.usageReadAt, originalAt)
  assert.equal(row.usageState, 'failed')
  assert.equal(row.usageError, failure.usageReason)
  assert.equal(usage.readings['claude:work'].usageCode, 'CLAUDE_USAGE_TIMEOUT')
  for (const changed of [
    { ...failure, allowanceBinding: 'b'.repeat(64) },
    { ...failure, authGeneration: { kind: 'file', token: 'd'.repeat(64) } },
    { ...failure, email: 'other@example.test' },
    { ...failure, status: 'signed_out', canServe: false },
    { ...failure, usageStatus: 'not_reported' },
  ]) {
    const next = await refresh(changed)
    assert.equal(next.readings['claude:work'].windows.weekly, null, 'old figures crossed a changed identity or a definitive new reading')
  }
})

test('an explicit unknown per-account measurement time is not replaced by the batch time', () => {
  const binding = 'b'.repeat(64)
  const list = readAccountList({ ok: true, accounts: [{ provider: 'grok', name: 'work', allowanceBinding: binding }] })
  for (const readAt of [null, 'not-a-time', '2031-99-99T00:00:00Z', 1e50]) {
    const usage = readUsageReply({ ok: true, readAt: inMs(0), accounts: [{ provider: 'grok', name: 'work',
      allowanceBinding: binding, status: 'healthy', usageStatus: 'measured', readAt,
      windows: { weekly: { usedPercent: 17 } } }] })
    const [row] = mergeAccounts(list, usage, { now: NOW })
    assert.equal(row.usageReadAt, typeof readAt === 'string' ? readAt : null)
    assert.equal(row.usageState, 'stale', 'a fresh batch made an unknown measurement date current')
  }
})

test('an unreported allowance keeps its specific explanation visible without replacing a sign-in fault', () => {
  const binding = 'd'.repeat(64)
  const list = readAccountList({ ok: true, accounts: [{ provider: 'claude', name: 'work', allowanceBinding: binding }] })
  const reading = { provider: 'claude', name: 'work', allowanceBinding: binding, status: 'healthy', canServe: true,
    usageStatus: 'not_reported', usageReason: 'Claude did not report an allowance percentage for this account.' }
  const [row] = mergeAccounts(list, readUsageReply({ ok: true, readAt: inMs(0), accounts: [reading] }), { now: NOW })
  assert.deepEqual(rowLines(row, { now: NOW }), [{ text: reading.usageReason, quiet: false }])
  const [signedOut] = mergeAccounts(list, readUsageReply({ ok: true, readAt: inMs(0), accounts: [
    { ...reading, status: 'signed_out', canServe: false, reason: 'This account is signed out.' },
  ] }), { now: NOW })
  assert.equal(needsSignIn(signedOut), true)
  assert.deepEqual(rowFlags(signedOut), [{ text: COPY.notSignedIn, tone: 'bad', title: null }])
  assert.ok(rowLines(signedOut, { now: NOW }).every(line => line.text !== reading.usageReason))
})

test('a reported monthly allowance survives normalization without creating a weekly window', () => {
  const binding = 'c'.repeat(64)
  const list = readAccountList({ ok: true, accounts: [{ provider: 'grok', name: 'work', allowanceBinding: binding }] })
  const usage = readUsageReply({ ok: true, readAt: inMs(0), accounts: [{ provider: 'grok', name: 'work',
    allowanceBinding: binding, status: 'exhausted', canServe: false, usageStatus: 'measured', usageSource: 'grok-billing',
    readAt: inMs(0), reportedUsage: { usedPercent: 100, period: 'month', resetsAt: inMs(24 * HOUR) } }] })
  const [row] = mergeAccounts(list, usage, { now: NOW })
  assert.equal(row.measured, true)
  assert.equal(row.usageState, 'current')
  assert.equal(row.canServe, false)
  assert.equal(row.reportedUsage?.usedPercent, 100)
  assert.equal(row.reportedUsage?.remainingPercent, 0)
  assert.equal(row.reportedUsage?.period, 'month')
  assert.equal(row.reportedUsage?.resetsAt, inMs(24 * HOUR))
  assert.equal(row.windows.weekly, null)
})

test('a future-dated allowance check is unknown freshness rather than a fresh measurement', () => {
  assert.equal(usageIsStale({ ok: true, readAt: inMs(60000) }, { now: NOW }), true)
})

test('agePhrase and usageIsStale read a timestamp the way a person would', () => {
  const now = Date.parse('2026-09-02T12:00:00.000Z')
  assert.equal(agePhrase('2026-09-02T11:59:40.000Z', { now }), 'just now')
  assert.equal(agePhrase('2026-09-02T11:50:00.000Z', { now }), '10 min ago')
  assert.equal(agePhrase('2026-09-02T09:00:00.000Z', { now }), '3h ago')
  assert.equal(agePhrase('2026-08-30T12:00:00.000Z', { now }), '3 days ago')
  assert.equal(agePhrase('not a date', { now }), null)
  assert.equal(agePhrase(null, { now }), null)
  assert.equal(USAGE_STALE_MS, 5 * 60 * 1000)
  assert.equal(usageIsStale({ ok: true, readAt: '2026-09-02T11:56:00.000Z' }, { now }), false)
  assert.equal(usageIsStale({ ok: true, readAt: '2026-09-02T11:54:00.000Z' }, { now }), true)
  assert.equal(usageIsStale({ ok: true, readAt: null }, { now }), true, 'a read with no time is stale, never trusted fresh')
  assert.equal(usageIsStale(null, { now }), true)
  assert.equal(usageIsStale({ ok: false, readAt: '2026-09-02T11:59:00.000Z' }, { now }), true)
})

test('renameAccount and removeAccount never throw and read a refusal\'s own sentence', async () => {
  const calls = []
  const scope = { mcProviders: {
    accounts: async () => ({ ok: true, accounts: [] }),
    accountRename: async request => { calls.push(['rename', request]); return { ok: true, renamed: true, name: request.newName } },
    accountRemove: async request => { calls.push(['remove', request]); return { ok: true, removed: true } },
  } }
  assert.deepEqual({ ...await renameAccount({ name: 'a', provider: 'codex', newName: 'b' }, scope) }, { ok: true, renamed: true, name: 'b', reason: null })
  assert.deepEqual({ ...await removeAccount({ name: 'a', provider: 'codex' }, scope) }, { ok: true, removed: true, reason: null })
  assert.deepEqual(calls, [['rename', { name: 'a', provider: 'codex', newName: 'b' }], ['remove', { name: 'a', provider: 'codex' }]])
  const refusing = { mcProviders: {
    accounts: async () => ({ ok: true, accounts: [] }),
    accountRename: async () => ({ ok: false, code: 'ACCOUNT_NAME_TAKEN', reason: 'That name is already used for this kind of account.' }),
    accountRemove: async () => { throw new Error('boom') },
  } }
  const taken = await renameAccount({ name: 'a', provider: 'codex', newName: 'b' }, refusing)
  assert.equal(taken.ok, false)
  assert.equal(taken.reason, 'That name is already used for this kind of account.', 'the shell\x27s own sentence is the one shown')
  const thrown = await removeAccount({ name: 'a', provider: 'codex' }, refusing)
  assert.equal(thrown.ok, false)
  assert.equal(thrown.reason, COPY.removeRefused)
  const missing = await renameAccount({ name: 'a', provider: 'codex', newName: 'b' }, { mcProviders: { accounts: async () => ({}) } })
  assert.equal(missing.ok, false)
  assert.equal(missing.reason, COPY.unavailable)
})

/* ------------------------------ the window a ranking reads ------------------------------ */

test('the rank-window ids equal the packaged engine\'s and the shell\'s, and the legacy mode id reads as the current one', () => {
  const engine = require_(path.join(REPO, 'capability', 'src', 'lib', 'multi-account', 'selection-modes.js'))
  const shell = require_(path.join(REPO, 'shell', 'account-registry.cjs'))
  assert.deepEqual([...RANK_WINDOW_IDS], [...engine.RANK_WINDOW_IDS],
    'the menu offers a window the packaged engine does not read (or the reverse)')
  assert.deepEqual([...RANK_WINDOW_IDS], [...shell.RANK_WINDOW_IDS],
    'the menu offers a window the shell refuses (or the reverse)')
  assert.equal(DEFAULT_RANK_WINDOW, engine.DEFAULT_RANK_WINDOW)
  assert.equal(normalizeRankWindow('weekly'), 'weekly')
  assert.equal(normalizeRankWindow('WEEKLY'), 'either', 'a window this build does not know reads as the default')
  assert.equal(normalizeRankWindow(undefined), 'either')
  assert.equal(rankWindowChoice('hourly').label, '5-hour window')
  assert.equal(rankWindowChoice('daily'), null)
  assert.deepEqual({ ...LEGACY_SELECTION_MODES }, { ...engine.LEGACY_SELECTION_MODES }, 'the legacy table mirrors the engine\'s')
  assert.equal(normalizeSelectionMode('expiring-first'), 'resets-soonest', 'the id the mode shipped under for a few hours still reads')
  assert.equal(isRankedMode('resets-soonest'), true)
})

test('a program\'s own rule arrives with own=true and inherits what it does not say', () => {
  const list = readAccountList({
    ok: true,
    accounts: [],
    policy: {
      selectionMode: 'even', recorded: true, reservePercent: 30, rankWindow: 'hourly',
      byProvider: {
        codex: { selectionMode: 'resets-soonest', reservePercent: 30, rankWindow: 'weekly', own: { selectionMode: true, reservePercent: false, rankWindow: true } },
        claude: { selectionMode: 'even', reservePercent: 30, rankWindow: 'hourly', own: { selectionMode: false, reservePercent: false, rankWindow: false } },
        /* An older shell says nothing for a program: it follows the rule above. */
      },
    },
  })
  assert.equal(list.policy.rankWindow, 'hourly')
  assert.deepEqual({ ...list.policy.byProvider.codex }, { selectionMode: 'resets-soonest', reservePercent: 30, rankWindow: 'weekly', own: { selectionMode: true, reservePercent: false, rankWindow: true } })
  assert.deepEqual({ ...list.policy.byProvider.claude }, { selectionMode: 'even', reservePercent: 30, rankWindow: 'hourly', own: { selectionMode: false, reservePercent: false, rankWindow: false } })
  assert.deepEqual({ ...list.policy.byProvider.gemini }, { selectionMode: 'even', reservePercent: 30, rankWindow: 'hourly', own: { selectionMode: false, reservePercent: false, rankWindow: false } })
  const odd = readAccountList({ ok: true, accounts: [], policy: { selectionMode: 'even', recorded: true, rankWindow: 'daily', byProvider: { codex: 'weekly' } } })
  assert.equal(odd.policy.rankWindow, 'either', 'an unreadable window falls to the default')
  assert.deepEqual({ ...odd.policy.byProvider.codex.own }, { selectionMode: false, reservePercent: false, rankWindow: false }, 'an unreadable per-program entry is no rule')
  const older = readAccountList({ ok: true, accounts: [], policy: { selectionMode: 'even', recorded: true, byProvider: { codex: { selectionMode: 'dynamic', own: true } } } })
  assert.deepEqual({ ...older.policy.byProvider.codex.own }, { selectionMode: true, reservePercent: true, rankWindow: true }, 'one boolean for the whole entry reads as all its own')
})

/* ------------------------------------------------------------------
   The answer that arrives without a press: one account, three values.
   ------------------------------------------------------------------ */

test('a pushed sign-in change is the same three-valued answer the list gives', () => {
  assert.deepEqual({ ...readSignInChange({ name: 'work', provider: 'claude', signedIn: 'yes' }) },
    { name: 'work', provider: 'claude', signedIn: true })
  assert.deepEqual({ ...readSignInChange({ name: 'work', provider: 'claude', signedIn: 'no' }) },
    { name: 'work', provider: 'claude', signedIn: false })
  assert.deepEqual(
    { ...readSignInChange({ name: 'work', provider: 'claude', signedIn: 'unknown' }) },
    { name: 'work', provider: 'claude', signedIn: null },
    '"could not look" reached the row as an answer instead of as nothing said',
  )
  /* A word this build does not know is the same as no word: not signed out. */
  assert.equal(readSignInChange({ name: 'work', provider: 'claude', signedIn: 'maybe' }).signedIn, null)

  /* Nothing that cannot name one listed account is taken at all. */
  assert.equal(readSignInChange(null), null)
  assert.equal(readSignInChange({ name: 'work', provider: 'nothing', signedIn: 'yes' }), null)
  assert.equal(readSignInChange({ name: '', provider: 'claude', signedIn: 'yes' }), null)
  assert.equal(readSignInChange('signed in'), null)
})

test('nothing is listened to unless the shell offers the push, and the listener detaches', () => {
  /* A copy with no such push is not a failure: the menu keeps working exactly
     as it did, with Check allowances as the fresh signal. */
  assert.equal(onSignInChanged(() => {}, { mcProviders: { accounts() {} } }), null)
  assert.equal(onSignInChanged(() => {}, {}), null)

  let detached = 0
  const delivered = []
  let push = null
  const scope = {
    mcProviders: {
      accounts() {},
      onAccountSignInChanged(listener) {
        push = listener
        return () => { detached += 1 }
      },
    },
  }
  const detach = onSignInChanged(change => { delivered.push(change) }, scope)
  assert.equal(typeof detach, 'function')

  push({ name: 'work', provider: 'claude', signedIn: 'yes' })
  /* An unreadable packet is dropped rather than delivered as a row state:
     the list read is the authority, and this is only a hint to take one. */
  push({ name: 'work', provider: 'martian', signedIn: 'yes' })
  push(undefined)
  assert.deepEqual(delivered.map(change => [change.name, change.signedIn]), [['work', true]])

  detach()
  assert.equal(detached, 1)
})

test('a push that throws on the way in leaves the menu working', () => {
  const scope = { mcProviders: { accounts() {}, onAccountSignInChanged() { throw new Error('no channel') } } }
  assert.equal(onSignInChanged(() => {}, scope), null)
  /* A shell that answers something other than an unsubscribe is not one. */
  const odd = { mcProviders: { accounts() {}, onAccountSignInChanged() { return 'detach' } } }
  assert.equal(onSignInChanged(() => {}, odd), null)
})

/* ------------------ Grok and Antigravity usage rows (2026-09-10) ------------------ *
 * Engine rows as the lane's health.js answers them, taken from its live
 * read-only run on 2026-09-10 (address replaced): Antigravity's print-mode
 * /quota measured the Gemini week and the Claude/GPT week; Grok's billing read
 * reported the plan and the week's end but no percentage. */
const USAGE_LIST = Object.freeze({
  ok: true,
  accounts: [
    { name: 'Gemini current OS sign-in', provider: 'gemini', allowanceBinding: FIXTURE_BINDINGS.antigravity, client: 'antigravity', priority: 14, signedIn: 'yes' },
    { name: 'work', provider: 'gemini', allowanceBinding: FIXTURE_BINDINGS.geminiWork, priority: 3, signedIn: 'yes' },
    { name: 'Current Grok CLI', provider: 'grok', allowanceBinding: FIXTURE_BINDINGS.grok, priority: 15, signedIn: 'yes' },
    { name: 'school', provider: 'codex', allowanceBinding: FIXTURE_BINDINGS.codexSchool, priority: 1, signedIn: 'yes' },
  ],
  activeByProvider: { codex: null, claude: null, gemini: null, grok: null },
})
const WEEK = 7 * 24 * HOUR
const GEMINI_WEEK = Object.freeze({ kind: 'weekly', usedPercent: 3.8, remainingPercent: 96.2, resetsAt: inMs(WEEK), label: 'gemini-weekly', model: 'Gemini Models' })
const OTHER_WEEK = Object.freeze({ kind: 'weekly', usedPercent: 0, remainingPercent: 100, resetsAt: inMs(WEEK + 2 * HOUR), label: '3p-weekly', model: 'Claude and GPT models' })
const AGY_ROW = Object.freeze({ name: 'Gemini current OS sign-in', provider: 'gemini', allowanceBinding: FIXTURE_BINDINGS.antigravity, client: 'antigravity', status: 'healthy', canServe: true,
  usedPercent: 3.8, resetsAt: inMs(WEEK), planType: null, email: null,
  windows: { hourly: null, weekly: GEMINI_WEEK, weeklyWindows: [GEMINI_WEEK, OTHER_WEEK] },
  reason: 'Antigravity models are available through this computer’s current sign-in. The folder does not provide a separate account. Antigravity reports 3.8% of this week’s Gemini allowance used.' })
const GROK_ROW = Object.freeze({ name: 'Current Grok CLI', provider: 'grok', allowanceBinding: FIXTURE_BINDINGS.grok, status: 'healthy', canServe: true, email: 'owner@example.test',
  usedPercent: null, resetsAt: inMs(WEEK), planType: 'X Premium+', windows: { hourly: null, weekly: null, weeklyWindows: [] },
  reason: 'Grok reports this week’s usage period but not how much of it is used, so usage is not measured. The first turn checks whether it can serve.' })

test('a measured Antigravity row draws its Gemini week and the other group beside it, each named for its group', () => {
  const rows = mergeAccounts(readAccountList(USAGE_LIST), readUsageReply({ ok: true, accounts: [AGY_ROW, GROK_ROW] }))
  const agy = rows.find(row => row.provider === 'gemini' && row.client === 'antigravity')
  assert.equal(agy.measured, true)
  assert.equal(agy.binding.model, 'Gemini Models', 'the deciding window is the Gemini week')
  const bars = accountBars(agy, { now: NOW })
  assert.deepEqual(bars.map(bar => [bar.label, bar.window ? bar.window.remainingPercent : null]),
    [['5-hour window', null], ['this week (Gemini Models)', 96.2], ['this week (Claude and GPT models)', 100]])
  assert.deepEqual(rowLines(agy, { now: NOW }).map(line => [line.text, line.quiet]), [
    ['96% free this week (Gemini Models) · resets in 7 days · 100% free this week (Claude and GPT models) · resets in 7 days', false],
  ])
})

test('a Grok row with no reported percentage says so in the engine’s words, with the period end, the address and the plan', () => {
  const rows = mergeAccounts(readAccountList(USAGE_LIST), readUsageReply({ ok: true, accounts: [AGY_ROW, GROK_ROW] }))
  const grok = rows.find(row => row.provider === 'grok')
  assert.equal(grok.measured, false, 'a Grok row nothing measured was treated as measured')
  assert.equal(grok.binding, null)
  assert.deepEqual(rowLines(grok, { now: NOW }).map(line => [line.text, line.quiet]), [
    [GROK_ROW.reason, false],
    ['This period resets in 7 days.', true],
    ['Signed in as owner@example.test.', true],
    ['Plan: X Premium+.', true],
  ])
  assert.deepEqual(rowFlags(grok), [], 'a healthy unmeasured Grok row was flagged')
  assert.ok(!rowLines(grok, { now: NOW }).some(line => /Gemini|0% free/.test(line.text)), 'a Grok row borrowed the Gemini sentence or drew 0%')
})

test('before a check and beside a fault, Grok and Antigravity rows say not known in their own program’s name; legacy Gemini is unchanged', () => {
  const unread = mergeAccounts(readAccountList(USAGE_LIST), null)
  assert.deepEqual(rowLines(unread.find(row => row.provider === 'grok')).map(line => line.text), [COPY.usageUnknown])
  assert.deepEqual(rowLines(unread.find(row => row.client === 'antigravity')).map(line => line.text), [COPY.usageUnknown])
  assert.deepEqual(rowLines(unread.find(row => row.provider === 'gemini' && row.name === 'work')).map(line => line.text), [COPY.usageNotMeasured])
  const failed = 'The check for "Current Grok CLI" failed (timeout), so it was not treated as spent.'
  const faulted = mergeAccounts(readUsageList(), readUsageReply({ ok: true, accounts: [
    { ...GROK_ROW, status: 'transient', canServe: false, email: null, planType: null, resetsAt: null, reason: failed },
  ] })).find(row => row.provider === 'grok')
  assert.deepEqual(rowLines(faulted, { now: NOW }).map(line => [line.text, line.quiet]), [[failed, true]],
    'a fault with a reason is said once, by its own line, with no allowance sentence to contradict it')
  const reasonless = mergeAccounts(readUsageList(), readUsageReply({ ok: true, accounts: [
    { ...GROK_ROW, status: 'transient', canServe: false, email: null, planType: null, resetsAt: null, reason: null },
  ] })).find(row => row.provider === 'grok')
  assert.deepEqual(rowLines(reasonless).map(line => line.text), ['Grok did not report how much of this account is used, so it stays not known.'])
  const signedOut = mergeAccounts(readUsageList(), readUsageReply({ ok: true, accounts: [
    { ...GROK_ROW, status: 'signed_out', canServe: false, email: null, planType: null, resetsAt: null, reason: 'This Grok home is not signed in.' },
  ] })).find(row => row.provider === 'grok')
  assert.deepEqual(rowLines(signedOut).map(line => line.text), [COPY.usageUnknown], 'the sign-out was said twice')
  function readUsageList() { return readAccountList(USAGE_LIST) }
})

test('a reported plan is one quiet line on any program’s row, and no line when the program named none', () => {
  const rows = mergeAccounts(readAccountList(USAGE_LIST), readUsageReply({ ok: true, accounts: [
    { name: 'school', provider: 'codex', allowanceBinding: FIXTURE_BINDINGS.codexSchool, status: 'healthy', canServe: true, planType: 'pro', windows: { weekly: { usedPercent: 77, resetsAt: inMs(3 * 24 * HOUR) } } },
    AGY_ROW,
  ] }))
  const codex = rows.find(row => row.provider === 'codex')
  assert.deepEqual(rowLines(codex, { now: NOW }).map(line => [line.text, line.quiet]),
    [['23% free this week · resets in 3 days', false], ['Plan: pro.', true]])
  const agy = rows.find(row => row.client === 'antigravity')
  assert.ok(!rowLines(agy, { now: NOW }).some(line => line.text.startsWith('Plan:')), 'a plan was invented for Antigravity')
})

const scopeFor = { scope: null }

/* T1582: THE ACCOUNTS MENU'S ADD APPLIES A SETUP ANSWER THAT WAITED FOR IT.
   Setup stored "Stop and let me switch" as a deferral because no account list
   existed; the first account added here used to arrive with automatic
   switching. A successful add now applies the stored answer; a refused add
   writes nothing. */
test('adding the first account applies the switching answer setup could not save', async () => {
  for (const [label, add, bridgeKey] of [
    ['managed', request => addManagedAccount(request, scopeFor.scope), 'accountAddManaged'],
    ['registered', request => addRegisteredAccount(request, scopeFor.scope), 'accountAdd'],
  ]) {
    const stored = new Map(), writes = []
    const answers = { autonomy: 'observe', screens: 'real', workspaceRoots: [], approvals: 'stop', attach: 'mirror', ideImport: 'none', failover: 'manual' }
    stored.set('mc.setup.profile', JSON.stringify({ schemaVersion: 1, status: 'complete', step: 'review', answers, updatedAtMs: 1,
      accountPolicyDeferred: { reason: 'There are no provider accounts to switch between yet.' } }))
    let added = false
    scopeFor.scope = {
      localStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) },
      mcProviders: {
        accounts: async () => ({ ok: true, accounts: added ? [{ name: 'work', provider: 'codex' }] : [], policy: { ok: true, policy: { recorded: false, selectionMode: 'priority' } } }),
        accountPolicy: async request => { writes.push(request); return { ok: true } },
        [bridgeKey]: async () => { added = true; return { ok: true, name: 'work', provider: 'codex' } },
      },
    }
    const answer = await add({ name: 'work', provider: 'codex', directory: '/work/codex' })
    assert.equal(answer.ok, true, `${label} add failed in the fixture`)
    assert.deepEqual(writes, [{ selectionMode: 'manual' }], `${label}: the stored "Stop and let me switch" was not applied to the first account`)
    assert.equal(JSON.parse(stored.get('mc.setup.profile')).accountPolicyDeferred, null, `${label}: the applied deferral was kept`)
  }
  const refusedWrites = []
  const refusedStore = new Map([['mc.setup.profile', JSON.stringify({ schemaVersion: 1, status: 'complete', step: 'review',
    answers: { autonomy: 'observe', screens: 'real', workspaceRoots: [], failover: 'manual' }, updatedAtMs: 1, accountPolicyDeferred: { reason: 'waiting' } })]])
  const refused = await addManagedAccount({ provider: 'codex' }, {
    localStorage: { getItem: key => refusedStore.get(key) ?? null, setItem: (key, value) => refusedStore.set(key, value) },
    mcProviders: { accounts: async () => ({ ok: true, accounts: [{ name: 'x', provider: 'codex' }], policy: { ok: true, policy: { recorded: false } } }),
      accountPolicy: async request => { refusedWrites.push(request); return { ok: true } },
      accountAddManaged: async () => ({ ok: false, code: 'ACCOUNT_LIMIT', reason: 'full' }) },
  })
  assert.equal(refused.ok, false)
  assert.deepEqual(refusedWrites, [], 'a refused add wrote the switching rule')
})
