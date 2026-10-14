/* THE PERMISSION LEVEL BUTTONS, PRESSED.
 *
 * WHAT THIS SUITE EXISTS TO CATCH, and why the suite next door could not.
 * tools/test/setup-profile.test.mjs proves the row is RENDERED: it calls
 * markup() and reads the result, and it greps the source for `chooseTier`. Both
 * were green for the whole life of a defect that made the control worse than
 * missing. `chooseTier` referenced `isWriteEnabled`, which the file never
 * imported, so every press: wrote the new level to the machine record on disk,
 * threw a ReferenceError one line later, and never repainted -- leaving the row
 * showing the OLD level, the whole section painted `disabled`, and nothing on
 * screen saying anything had happened. The identifier shipped unbound in the
 * renderer bundle of every build that ever carried this row.
 *
 * Presence is what a source match sees, and presence is exactly what survives
 * this family of defect. So this suite PRESSES THE BUTTON: it binds the real
 * controller to a root, dispatches the click the browser would dispatch, and
 * reads the markup the controller paints afterwards. A handler that throws
 * fails here in the only way that matters -- the screen stops telling the truth
 * about the machine.
 *
 * The module reads its bridge and its storage from globals while its module
 * graph evaluates (SETUP_RESOLUTION in src/setup-state.js), so both are
 * installed BEFORE the dynamic import below. Node runs each test file in its
 * own process, so nothing here leaks into another suite.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

/* ---------- the machine this page is talking to ---------- */

const machine = { tier: 'guided', writes: [] }
const store = new Map()

globalThis.localStorage = {
  getItem: key => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => { store.set(key, String(value)) },
  removeItem: key => { store.delete(key) },
}

/* Every event this module dispatches goes through here, so a test can make the
   step AFTER the disk write fail -- which is exactly the shape of the shipped
   defect -- without editing the module. */
let dispatchThrows = false
globalThis.window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => {
    if (dispatchThrows) throw new Error('this window cannot take an event')
    return true
  },
}

/* THE OTHER WRITERS A LEVEL CHANGE REACHES. Since the owner's Basic direction
   (T782) a fresh profile's answers are the autonomous ones, so re-deriving
   the intents after a level change writes the permission-question, editor
   import and account-switching policies through the same bridges the real
   preload exposes (shell/fleet-profile-preload.cjs: mcSettings.set,
   mcSetup.setEditorImportPolicy, mcProviders.accountPolicy). Without them
   applySetupIntentChanges refuses on an installed copy, which is right for
   the product and wrong for a fixture that stands in for one. */
const intentWrites = []
globalThis.mcSettings = { set: async (id, value) => { intentWrites.push(['settings', id, value]); return { ok: true, id, value } } }
globalThis.mcProviders = { accountPolicy: async request => { intentWrites.push(['accounts', request]); return { ok: true } } }
globalThis.mcSetup = {
  setEditorImportPolicy: async policy => { intentWrites.push(['editor-import', policy]); return { ok: true } },
  bootstrap: { ok: true, available: true, configured: true, tier: machine.tier },
  chooseTier: async (tier, consent) => {
    /* The real handler writes to disk before it answers, and that ordering is
       the whole reason the defect was dangerous rather than merely broken.
       Since X4 it also refuses the widest level without a confirmed consent
       (shell/tier-consent.cjs); the stub does the same so this suite presses
       the confirm control the way a person has to. */
    if (tier === 'unrestricted' && consent?.confirmed !== true) {
      return { ok: false, code: 'SETUP_UNRESTRICTED_UNCONFIRMED', reason: 'refused by the stub shell' }
    }
    machine.tier = tier
    machine.writes.push(tier)
    return { ok: true, tier }
  },
  tierConsent: async () => ({ ok: true, recorded: false }),
}

const { createSetupProfileSettings, tierRecordDisposition } = await import('../../src/setup-profile-settings.js')
const { SETUP_RESOLUTION } = await import('../../src/setup-state.js')

/* ---------- the smallest DOM the controller actually uses ---------- */

/* bind() attaches one click listener; refresh() looks for its own section and
   replaces its outerHTML. That is the entire DOM surface of this module, so
   this is the entire DOM. Painted markup is kept, because the painted markup is
   what a person reads. */
function fakeHost() {
  const painted = []
  let listener = null
  const section = {
    querySelector: () => null,
    set outerHTML(value) { painted.push(String(value)) },
  }
  const root = {
    addEventListener: (type, fn) => { if (type === 'click') listener = fn },
    removeEventListener: () => {},
    contains: () => true,
    querySelector: selector => (selector === '[data-setup-profile-system]' ? section : null),
  }
  return {
    root,
    painted,
    last: () => painted[painted.length - 1] || '',
    /* The click a browser dispatches when one of the level buttons is pressed:
       the button carries the two data attributes the markup gives it, and
       closest() answers with the button itself. */
    press(tier) {
      assert.ok(listener, 'the controller never bound a click listener, so no button on it can ever be pressed')
      listener({
        target: {
          closest: selector => (selector === '[data-setup-profile-set]'
            ? { dataset: { setupProfileSet: 'tier', setupProfileValue: tier } }
            : null),
        },
      })
    },
    /* The confirm control on the risk block the widest level opens (X4). The
       block itself is the subject of tools/test/setup-unrestricted-gate.test.mjs;
       here it is only the extra press a person makes on the way to the disk. */
    confirm() {
      listener({ target: { closest: selector => (selector === '[data-unrestricted-confirm]' ? { dataset: {} } : null) } })
    },
  }
}

/* The handler is async and nothing awaits it -- a click handler cannot -- so
   the assertions wait for the microtasks it schedules, the same way the screen
   does. */
const settle = () => new Promise(resolve => setImmediate(resolve))

const pressedIn = (markup, tier) => new RegExp(`data-setup-profile-value="${tier}"[^>]*aria-pressed="true"`).test(markup)
const tierButtons = markup => markup.match(/<button\b[^>]*data-setup-profile-set="tier"[^>]*>/g) || []
function assertTierUsable(markup) {
  const buttons = tierButtons(markup)
  assert.equal(buttons.length, 3, 'all permission levels must still be reachable')
  assert.ok(buttons.every(button => !/\sdisabled(?:\s|>)/.test(button)),
    'the permission controls stayed disabled after the change; unrelated unavailable controls do not establish this')
}

function mounted() {
  const controller = createSetupProfileSettings()
  const host = fakeHost()
  controller.bind(host.root)
  controller.afterRender(host.root)
  return { controller, host }
}

test('pressing a permission level records it AND says so on the row that was pressed', async () => {
  machine.writes.length = 0
  const { host } = mounted()

  host.press('unrestricted')
  await settle()
  host.confirm()
  await settle()

  assert.deepEqual(machine.writes, ['unrestricted'], 'the level was not recorded on the machine exactly once')
  assert.equal(SETUP_RESOLUTION.tier, 'unrestricted', 'the screen still believes in the level the machine no longer holds')

  const painted = host.last()
  assert.ok(painted.length > 0, 'the section never repainted, so the row still shows the level the machine no longer has')
  assert.ok(pressedIn(painted, 'unrestricted'), 'the row that was pressed does not read as chosen after the press')
  assert.ok(!pressedIn(painted, 'guided'), 'the row still reads as the old level after the machine moved to a new one')
  assertTierUsable(painted)
  assert.match(painted, /Permission level changed/, 'nothing on screen says the level changed')
})

test('a press while a press is still in flight cannot write a second level', async () => {
  machine.writes.length = 0
  const { host } = mounted()

  host.press('standard')
  host.press('guided')
  await settle()

  assert.deepEqual(machine.writes, ['standard'], 'a second press during the first wrote another level to the machine')
})

test('a failure after the disk write leaves the screen honest and the section usable', async () => {
  machine.writes.length = 0
  const { host } = mounted()
  /* persist() dispatches through window on its way to the write flags, so this
     makes a step AFTER the machine has already moved throw -- the exact shape
     of the shipped ReferenceError, without pretending to be it. */
  dispatchThrows = true
  try {
    host.press('unrestricted')
    await settle()
    host.confirm()
    await settle()
  } finally {
    dispatchThrows = false
  }

  assert.deepEqual(machine.writes, ['unrestricted'], 'the machine write is the step that did happen')
  const painted = host.last()
  assert.ok(painted.length > 0, 'a failed step left the section painted disabled with no repaint to come')
  assert.ok(pressedIn(painted, 'unrestricted'), 'the row does not show the level this computer now records')
  assertTierUsable(painted)
  assert.match(painted, /could not finish the change/, 'the failure is not stated anywhere a person can read it')

  /* And the section is genuinely usable afterwards: the next press works. */
  machine.writes.length = 0
  host.press('guided')
  await settle()
  assert.deepEqual(machine.writes, ['guided'], 'the section stopped accepting presses after a failure')
  assert.ok(pressedIn(host.last(), 'guided'), 'the row does not follow the machine after a recovery')
})

/* AUDIT OFF IS NOT A FAILED RECORD (owner direction 2026-09-20, T782; the
   shell's shape is shell/tier-consent.cjs auditedTierChoice, the engine's
   not-required object is M10's exact contract). With optional auditing off
   the shell answers recorded = the exact not-required object for
   'setup.tier.choose' on 'tier:<level>' carrying intentAudit, the exact
   object for the intent: the level moved, no ledger record was requested,
   and the row says exactly that -- never "recorded in the signed ledger",
   never that recording failed. A recorded pair { ok, sequence, intentSequence }
   is the signed ledger's own answer and is named as one. Nothing else may
   claim a record: ok: true with signed: false, ok: true with no pair, the
   old ten-field object with no action or target (a claim for no operation),
   a not-required object for another level -- the level changed, and the row
   says its record could not be confirmed. A refused record says so; a copy
   with no ledger writer says so. The level is named as changed every time. */
test('a level change with auditing off says no record was requested; only the signed ledger\'s own pair claims the signed ledger; nothing contradictory is quiet', async () => {
  const original = globalThis.mcSetup.chooseTier
  /* The shell's whole answer: { ok, tier, recorded, intentAudit? } with
     intentAudit a TOP-LEVEL field beside recorded (shell/tier-consent.cjs
     auditedTierChoice; Controller review of v3, F5). */
  const notRequired = (tier, action = 'setup.tier.choose') => ({ ok: true, disposition: 'not-required', required: false, recorded: false, durable: false, anchored: false, signed: false, sequence: null, eventId: null, eventHash: null, action, target: `tier:${tier}` })
  const answers = [
    { answer: tier => ({ recorded: notRequired(tier), intentAudit: notRequired(tier, 'setup.tier.choose.intent') }),
      expect: /Activity auditing is off, so no ledger record was requested/, forbid: /signed ledger|could not be recorded|could not be confirmed/ },
    { answer: () => ({ recorded: { ok: true, sequence: 8, intentSequence: 7 } }), expect: /recorded in the signed ledger/, forbid: /no ledger record was requested|could not be/ },
    { answer: () => ({ recorded: { ok: true, signed: false } }), expect: /The level changed, but its activity record could not be confirmed/, forbid: /was recorded|no ledger record was requested/ },
    { answer: () => ({ recorded: { ok: true, signed: true, sequence: 7 } }), expect: /could not be confirmed/, forbid: /recorded in the signed ledger|no ledger record was requested/ },
    { answer: () => ({ recorded: { ok: true, sequence: 7, intentSequence: 7 } }), expect: /could not be confirmed/, forbid: /recorded in the signed ledger/ },
    { answer: () => ({ recorded: { ok: true, disposition: 'not-required', required: false, recorded: false, durable: false, anchored: false, signed: false, sequence: null, eventId: null, eventHash: null } }),
      expect: /could not be confirmed/, forbid: /no ledger record was requested|signed ledger/ },
    { answer: tier => ({ recorded: notRequired(tier === 'guided' ? 'standard' : 'guided'), intentAudit: notRequired(tier, 'setup.tier.choose.intent') }),
      expect: /could not be confirmed/, forbid: /no ledger record was requested|signed ledger/ },
    { answer: tier => ({ recorded: notRequired(tier), intentAudit: { ok: false, code: 'AUDIT_UNAVAILABLE' } }),
      expect: /could not be confirmed/, forbid: /no ledger record was requested|signed ledger/ },
    { answer: tier => ({ recorded: { ...notRequired(tier), intentAudit: notRequired(tier, 'setup.tier.choose.intent') } }),
      expect: /could not be confirmed/, forbid: /no ledger record was requested|signed ledger/ },
    { answer: tier => ({ recorded: notRequired(tier) }), expect: /could not be confirmed/, forbid: /no ledger record was requested|signed ledger/ },
    { answer: tier => ({ recorded: { ok: true, sequence: 8, intentSequence: 7 }, intentAudit: notRequired(tier, 'setup.tier.choose.intent') }),
      expect: /could not be confirmed/, forbid: /no ledger record was requested|recorded in the signed ledger/ },
    { answer: () => ({ recorded: { ok: false, required: true, code: 'AUDIT_WRITE_FAILED' } }), expect: /could not be recorded in the signed ledger/, forbid: /no ledger record was requested|could not be confirmed/ },
    { answer: () => ({ recorded: { ok: false, code: 'AUDIT_PAYLOAD_ABSENT' } }), expect: /This copy carries no ledger writer, so the change was not recorded/, forbid: /no ledger record was requested|could not be confirmed/ },
  ]
  try {
    for (const { answer, expect, forbid } of answers) {
      machine.writes.length = 0
      let recorded
      globalThis.mcSetup.chooseTier = async tier => { machine.tier = tier; machine.writes.push(tier); recorded = answer(tier); return { ok: true, tier, ...recorded } }
      const { host } = mounted()
      host.press(machine.tier === 'standard' ? 'guided' : 'standard')
      await settle()
      const painted = host.last()
      assert.match(painted, /Permission level changed/, JSON.stringify(recorded))
      assert.match(painted, expect, JSON.stringify(recorded))
      assert.doesNotMatch(painted, forbid, JSON.stringify(recorded))
    }
  } finally { globalThis.mcSetup.chooseTier = original }
})

/* The classifier on its own, against the shell's exact shapes
   (shell/tier-consent.cjs auditedTierChoice): the sentence above is only as
   honest as this reading. */
test('tierRecordDisposition reads the shell\'s answer exactly, and nothing contradictory or partial passes as quiet or as a record', () => {
  const nr = (tier, action = 'setup.tier.choose') => ({ ok: true, disposition: 'not-required', required: false, recorded: false, durable: false, anchored: false, signed: false, sequence: null, eventId: null, eventHash: null, action, target: `tier:${tier}` })
  const answer = (recorded, intentAudit) => (intentAudit === undefined ? { ok: true, tier: 'guided', recorded } : { ok: true, tier: 'guided', recorded, intentAudit })
  assert.equal(tierRecordDisposition(answer(nr('guided'), nr('guided', 'setup.tier.choose.intent')), 'guided'), 'not-required')
  assert.equal(tierRecordDisposition(answer({ ok: true, sequence: 8, intentSequence: 7 }), 'guided'), 'recorded')
  assert.equal(tierRecordDisposition(answer({ ok: true, sequence: 8, intentSequence: 7, disposition: 'recorded', signed: true, action: 'setup.tier.choose', target: 'tier:guided' }), 'guided'), 'recorded', 'consistent extra fields do not contradict')
  assert.equal(tierRecordDisposition(answer({ ok: false, code: 'AUDIT_PAYLOAD_ABSENT' }), 'guided'), 'no-writer')
  assert.equal(tierRecordDisposition(answer({ ok: false, code: 'AUDIT_UNAVAILABLE' }), 'guided'), 'refused')
  assert.equal(tierRecordDisposition(answer({ ok: false }), 'guided'), 'refused')
  assert.equal(tierRecordDisposition({ ok: true, tier: 'guided' }, 'guided'), 'absent', 'a confined-to-confined move has no ledger step')
  for (const [shellAnswer, why, tier = 'guided'] of [
    [answer(nr('guided'), nr('guided', 'setup.tier.choose.intent')), 'the not-required pair for another level', 'standard'],
    [answer(nr('guided')), 'a not-required outcome with no intent beside it'],
    [answer(nr('guided'), nr('guided')), 'an intent claim carrying the outcome action'],
    [answer(nr('guided'), { ok: false, code: 'AUDIT_UNAVAILABLE' }), 'an intent that was refused beside a not-required outcome'],
    [answer({ ...nr('guided'), intentAudit: nr('guided', 'setup.tier.choose.intent') }), 'the intent nested inside recorded (the v3 reading) is not the shell\'s shape'],
    [answer({ ...nr('guided'), recorded: true }, nr('guided', 'setup.tier.choose.intent')), 'a not-required object that claims a record'],
    [answer({ ...nr('guided'), extra: 1 }, nr('guided', 'setup.tier.choose.intent')), 'a field the contract does not have'],
    [answer((() => { const { eventId, ...rest } = nr('guided'); return rest })(), nr('guided', 'setup.tier.choose.intent')), 'a field the contract has, missing'],
    [answer({ ok: false, disposition: 'not-required', required: false }, nr('guided', 'setup.tier.choose.intent')), 'ok: false beside not-required'],
    [{ ok: true, tier: 'guided', intentAudit: nr('guided', 'setup.tier.choose.intent') }, 'an intent with no recorded at all'],
    [answer({ ok: true, sequence: 8, intentSequence: 7 }, nr('guided', 'setup.tier.choose.intent')), 'a recorded pair with a not-required intent beside it (mixed)'],
    [answer({ ok: false, code: 'AUDIT_UNAVAILABLE' }, nr('guided', 'setup.tier.choose.intent')), 'a refusal with a not-required intent beside it (mixed)'],
    [answer({ ok: true }), 'ok with nothing to show'],
    [answer({ ok: true, signed: false }), 'signed: false beside ok: true'],
    [answer({ ok: true, sequence: 8, intentSequence: 7, signed: false }), 'signed: false beside a pair'],
    [answer({ ok: true, sequence: 7 }), 'an outcome sequence without its intent'],
    [answer({ ok: true, sequence: 7, intentSequence: 7 }), 'an outcome that did not follow its intent'],
    [answer({ ok: true, sequence: 8, intentSequence: 7, target: 'tier:standard' }), 'a pair recorded for another level'],
    [answer({ ok: true, sequence: 8, intentSequence: 7, disposition: 'not-recorded' }), 'a pair with a contradicting disposition'],
    [answer(null), 'a null record'],
    [answer([]), 'an array record'],
    [answer('recorded'), 'a string record'],
    [null, 'no answer'],
    ['recorded', 'a string answer'],
  ]) assert.equal(tierRecordDisposition(shellAnswer, tier), 'unconfirmed', why)
})

/* THE ACTUAL SHELL PRODUCER → THE ACTUAL RENDERER (Controller review of v3,
   F5). shell/tier-consent.cjs auditedTierChoice is run with a recorder that
   answers the way the Engine does -- with auditing off, operation-audit's
   own skippedStatus (the exact not-required object, required from the
   configured Engine root); with auditing on, sequence receipts -- and its
   return value, untouched, is what mcSetup.chooseTier hands the setup
   section. The sentence painted must read that actual answer. A move into
   the widest level with consent is used because that is the move the ledger
   records (recordsOnLedger); the widest level requires the consent record, so
   the answer carries recorded and, with auditing off, intentAudit. */
test('the shell\'s actual tier answer, produced by auditedTierChoice, is read by the row as it is: audit off says no record was requested; audit on says the signed ledger', async () => {
  const { createRequire } = await import('node:module')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const { canonicalRootForTests } = await import('../canonical-root.mjs')
  const require_ = createRequire(import.meta.url)
  const engineRoot = canonicalRootForTests()
  const skipped = path.join(engineRoot, 'src', 'lib', 'operation-audit.js')
  const { skippedStatus } = require_(skipped)
  const { auditedTierChoice, TIER_CHOICE_ACTION, TIER_CHOICE_INTENT_ACTION } = require_(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'shell', 'tier-consent.cjs'))
  const consent = { riskShown: true, confirmed: true, riskText: 'The words shown.', shownAtMs: 1_700_000_000_000, via: 'settings' }
  const original = globalThis.mcSetup.chooseTier
  try {
    for (const [name, record, expect, forbid] of [
      ['auditing off', (action, target) => skippedStatus(action, target), /Activity auditing is off, so no ledger record was requested/, /signed ledger|could not be recorded|could not be confirmed/],
      ['auditing on', (() => { let sequence = 100; return () => ({ ok: true, sequence: ++sequence, eventHash: 'd'.repeat(64) }) })(), /recorded in the signed ledger/, /no ledger record was requested|could not be/],
    ]) {
      const actual = await auditedTierChoice({ tier: 'unrestricted', previousTier: 'standard', consent, principal: 'account:test',
        record: async (action, target) => record(action, target), run: () => ({ ok: true, tier: 'unrestricted' }) })
      assert.equal(actual.ok, true, name + ': the shell admitted the move')
      if (name === 'auditing off') {
        assert.equal(actual.recorded.action, TIER_CHOICE_ACTION); assert.equal(actual.intentAudit.action, TIER_CHOICE_INTENT_ACTION)
        assert.equal(actual.recorded.target, 'tier:unrestricted'); assert.equal(Object.hasOwn(actual.recorded, 'intentAudit'), false, 'the intent rides beside recorded, not inside it')
      } else assert.deepEqual(actual.recorded, { ok: true, sequence: 102, intentSequence: 101 })
      machine.writes.length = 0
      machine.tier = 'standard'
      /* The screen believes what the machine record last said (setup-state);
         the first iteration moved it to the widest level, so the record moves
         back the way the product moves it before the next press. */
      const { noteTierRecorded } = await import('../../src/setup-state.js')
      noteTierRecorded('standard')
      globalThis.mcSetup.chooseTier = async tier => { machine.tier = tier; machine.writes.push(tier); return actual }
      const { host } = mounted()
      host.press('unrestricted')
      await settle()
      host.confirm()
      await settle()
      assert.deepEqual(machine.writes, ['unrestricted'], name + ': the confirmed press reached the shell once')
      const painted = host.last()
      assert.match(painted, /Permission level changed/, name)
      assert.match(painted, expect, name)
      assert.doesNotMatch(painted, forbid, name)
    }
  } finally { globalThis.mcSetup.chooseTier = original }
})
