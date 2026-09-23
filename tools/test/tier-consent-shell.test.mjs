/* THE SHELL'S HALF OF THE MOMENT OF CHOOSING FULL ACCESS.
 *
 * shell/tier-consent.cjs is the part that cannot be argued with from a screen:
 * it refuses to record the widest permission level without a confirmed consent
 * carrying the words that were shown, and it writes the choice -- every choice
 * -- to the canonical signed ledger, intent first. This suite drives it with a
 * fake recorder and a fake finder, so every branch is exercised without a
 * window: admitted, refused for want of consent, refused because the ledger is
 * present and will not record, proceeding on an absent ledger, and the reader
 * that must never call a legacy install "confirmed".
 *
 * The choose-tier handler and sender gate are evaluated from their actual
 * source below, with an in-memory machine record and inert filesystem, to
 * exercise interleaving at the audit await. Electron/window acceptance remains
 * separate in tools/unrestricted-consent-qa.mjs.
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import vm from 'node:vm'
import { parseAst } from 'rollup/parseAst'

const require_ = createRequire(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = relative => readFileSync(path.join(REPO_ROOT, relative), 'utf8')

const {
  TIER_CHOICE_ACTION,
  TIER_CHOICE_INTENT_ACTION,
  auditedTierChoice,
  checkTierChoice,
  normalizeConsent,
  readConsentState,
  recordsOnLedger,
  requiresConsent,
  riskTextSha256,
  tierChoiceDetails,
} = require_(path.join(REPO_ROOT, 'shell', 'tier-consent.cjs'))

const WORDS = 'This level gives an AI agent complete, unsandboxed control of your computer. Do you want to give an AI agent full access to this computer?'
const CONSENT = Object.freeze({ riskShown: true, confirmed: true, riskText: WORDS, shownAtMs: 1_700_000_000_000, via: 'settings' })

function recorder({ refuse = null } = {}) {
  const rows = []
  let sequence = 100
  return {
    rows,
    record(action, target, details) {
      if (refuse) return refuse
      sequence += 1
      rows.push({ action, target, details, sequence })
      return { ok: true, sequence, eventHash: `hash-${sequence}` }
    },
  }
}

test('consent is required exactly when the level CHANGES to the widest one', () => {
  assert.equal(requiresConsent({ tier: 'unrestricted', previousTier: 'guided' }), true)
  assert.equal(requiresConsent({ tier: 'unrestricted', previousTier: null }), true)
  assert.equal(requiresConsent({ tier: 'unrestricted', previousTier: 'unrestricted' }), false, 're-recording the level a machine already holds is not enabling it')
  assert.equal(requiresConsent({ tier: 'guided', previousTier: 'unrestricted' }), false)
  assert.equal(requiresConsent({ tier: 'standard', previousTier: null }), false)
})

test('the widest level is refused without a confirmed consent, and the refusal says what to do', () => {
  for (const consent of [null, undefined, {}, [], 'yes', { confirmed: true }, { riskShown: true, riskText: WORDS }, { riskShown: true, confirmed: 'true', riskText: WORDS }, { riskShown: false, confirmed: true, riskText: WORDS }]) {
    const verdict = checkTierChoice({ tier: 'unrestricted', previousTier: 'guided', consent })
    assert.equal(verdict.ok, false, `admitted with consent ${JSON.stringify(consent)}`)
    assert.equal(verdict.code, 'SETUP_UNRESTRICTED_UNCONFIRMED')
    assert.match(verdict.reason, /Full access was not turned on/)
    assert.match(verdict.reason, /Choose it again/)
  }
  const admitted = checkTierChoice({ tier: 'unrestricted', previousTier: 'guided', consent: CONSENT })
  assert.equal(admitted.ok, true)
  assert.equal(admitted.consent.confirmed, true)
})

test('normalizeConsent keeps five fields and drops everything else', () => {
  const normalized = normalizeConsent({ ...CONSENT, extra: 'dropped', via: 'elsewhere' })
  assert.deepEqual(normalized, { riskShown: true, confirmed: true, riskText: WORDS, shownAtMs: CONSENT.shownAtMs, via: null })
  assert.equal(normalizeConsent({ ...CONSENT, riskText: '' }), null, 'a consent with no words is not a consent')
  assert.equal(normalizeConsent({ ...CONSENT, riskText: 'x'.repeat(4001) }), null, 'an oversized text is refused rather than truncated into a different record')
})

test('the details carry from, to, the showing, and the words with their hash', () => {
  const details = tierChoiceDetails({ tier: 'unrestricted', previousTier: 'standard', consent: CONSENT, principal: 'account:abc' })
  assert.equal(details.surface, 'app.ipc')
  assert.equal(details.principal, 'account:abc')
  assert.equal(details.from, 'standard')
  assert.equal(details.to, 'unrestricted')
  assert.equal(details.riskShown, true)
  assert.equal(details.riskConfirmed, true)
  assert.equal(details.riskText, WORDS)
  assert.equal(details.riskTextSha256, riskTextSha256(WORDS))
  assert.match(details.riskTextSha256, /^[0-9a-f]{64}$/)
  assert.equal(details.riskShownAtMs, CONSENT.shownAtMs)
  assert.equal(details.via, 'settings')
  /* A narrower move with no consent says so, plainly and without a hash of nothing. */
  const narrower = tierChoiceDetails({ tier: 'guided', previousTier: 'unrestricted', consent: null, principal: 'unauthenticated' })
  assert.equal(narrower.riskShown, false)
  assert.equal(narrower.riskConfirmed, false)
  assert.equal(narrower.riskTextSha256, null)
  assert.equal(narrower.riskText, null)
})

test('a confirmed choice writes intent THEN outcome, in that order, and the outcome names the intent', async () => {
  const ledger = recorder()
  const writes = []
  const result = await auditedTierChoice({
    tier: 'unrestricted', previousTier: 'guided', consent: CONSENT, principal: 'account:abc',
    record: ledger.record,
    run: () => { writes.push('disk'); return { ok: true, tier: 'unrestricted', configured: true } },
  })
  assert.equal(result.ok, true)
  assert.equal(result.tier, 'unrestricted')
  assert.deepEqual(result.recorded, { ok: true, sequence: 102, intentSequence: 101 })
  assert.deepEqual(ledger.rows.map(row => row.action), [TIER_CHOICE_INTENT_ACTION, TIER_CHOICE_ACTION])
  assert.deepEqual(ledger.rows.map(row => row.target), ['tier:unrestricted', 'tier:unrestricted'])
  assert.equal(ledger.rows[0].sequence < ledger.rows[1].sequence, true)
  assert.equal(ledger.rows[1].details.outcome, 'ok')
  assert.equal(ledger.rows[1].details.intentSequence, 101)
  assert.equal(ledger.rows[1].details.riskConfirmed, true)
  assert.equal(ledger.rows[1].details.riskText, WORDS)
  assert.deepEqual(writes, ['disk'])
})

test('a refused ledger that is PRESENT stops the change before the disk moves', async () => {
  const ledger = recorder({ refuse: { ok: false, code: 'AUDIT_ANCHOR_STALE', reason: 'stale' } })
  let ran = false
  const result = await auditedTierChoice({
    tier: 'unrestricted', previousTier: 'guided', consent: CONSENT, principal: 'x',
    record: ledger.record,
    run: () => { ran = true; return { ok: true, tier: 'unrestricted' } },
  })
  assert.equal(ran, false, 'the disk moved although the intent could not be recorded')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'SETUP_AUDIT_UNAVAILABLE')
  assert.match(result.reason, /was not changed/)
  assert.match(result.reason, /could not be recorded in the signed ledger/)
  assert.match(result.reason, /Try again/)
})

test('a malformed intent receipt is reported instead of throwing from the tier handler', async () => {
  let ran = false
  const result = await auditedTierChoice({
    tier: 'unrestricted', previousTier: 'guided', consent: CONSENT, principal: 'x',
    record: () => undefined,
    run: () => { ran = true; return { ok: true, tier: 'unrestricted' } },
  })
  assert.equal(ran, false, 'the disk moved although the recorder returned no receipt')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'SETUP_AUDIT_UNAVAILABLE')
})

test('an ABSENT ledger proceeds and says so, exactly as accounts do', async () => {
  const ledger = recorder({ refuse: { ok: false, code: 'AUDIT_PAYLOAD_ABSENT', reason: 'no payload' } })
  const result = await auditedTierChoice({
    tier: 'unrestricted', previousTier: 'guided', consent: CONSENT, principal: 'x',
    record: ledger.record,
    run: () => ({ ok: true, tier: 'unrestricted' }),
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.recorded, { ok: false, code: 'AUDIT_PAYLOAD_ABSENT' })
})

test('a refused write is recorded as refused, and reported as the write said', async () => {
  const ledger = recorder()
  const result = await auditedTierChoice({
    tier: 'guided', previousTier: 'unrestricted', consent: null, principal: 'x',
    record: ledger.record,
    run: () => ({ ok: false, code: 'SETUP_MACHINE_RECORD_WRITE_FAILED', reason: 'disk full' }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'SETUP_MACHINE_RECORD_WRITE_FAILED')
  assert.equal(ledger.rows[1].details.outcome, 'refused')
  assert.equal(ledger.rows[1].details.code, 'SETUP_MACHINE_RECORD_WRITE_FAILED')
  assert.equal(result.recorded.ok, true, 'the refused outcome was not itself recorded')
})

test('only moves that involve the widest level touch the ledger at all', () => {
  /* MEASURED, 2026-08-18: the first Continue on a fresh install is a
     confined-to-confined move, it lands while the capability layer is writing
     its own first-boot records into the same fresh ledger, and two more
     synchronous signed writes on that press held the walkthrough's save past
     ten seconds (tools/setup-walkthrough-qa.mjs went red; a four-second settle
     made the same staged build pass). The ruling requires the record for the
     FULL-ACCESS choice; the recommended path keeps its old cost. */
  assert.equal(recordsOnLedger({ tier: 'guided', previousTier: null }), false)
  assert.equal(recordsOnLedger({ tier: 'standard', previousTier: 'guided' }), false)
  assert.equal(recordsOnLedger({ tier: 'unrestricted', previousTier: 'guided' }), true)
  assert.equal(recordsOnLedger({ tier: 'unrestricted', previousTier: 'unrestricted' }), true)
  assert.equal(recordsOnLedger({ tier: 'guided', previousTier: 'unrestricted' }), true)
})

test('a confined-to-confined move writes no ledger row and cannot be stopped by a refusing ledger', async () => {
  const ledger = recorder({ refuse: { ok: false, code: 'AUDIT_ANCHOR_STALE', reason: 'stale' } })
  const result = await auditedTierChoice({
    tier: 'guided', previousTier: null, consent: null, principal: 'x',
    record: ledger.record,
    run: () => ({ ok: true, tier: 'guided', configured: true }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.recorded, undefined, 'a move the ledger does not hold must not claim a recording outcome')
  assert.equal(ledger.rows.length, 0)
})

test('leaving full access proceeds even when a PRESENT ledger refuses: nobody is trapped at the widest level', async () => {
  const ledger = recorder({ refuse: { ok: false, code: 'AUDIT_ANCHOR_STALE', reason: 'stale' } })
  let ran = false
  const result = await auditedTierChoice({
    tier: 'guided', previousTier: 'unrestricted', consent: null, principal: 'x',
    record: ledger.record,
    run: () => { ran = true; return { ok: true, tier: 'guided' } },
  })
  assert.equal(ran, true, 'a sick ledger stopped a person from LEAVING full access')
  assert.equal(result.ok, true)
  assert.deepEqual(result.recorded, { ok: false, code: 'AUDIT_ANCHOR_STALE' }, 'the missing record is not stated')
})

test('a narrower level needs no consent and is still recorded, so the chain reads down and up', async () => {
  const ledger = recorder()
  const down = await auditedTierChoice({ tier: 'guided', previousTier: 'unrestricted', consent: null, principal: 'x', record: ledger.record, run: () => ({ ok: true, tier: 'guided' }) })
  assert.equal(down.ok, true)
  assert.equal(ledger.rows[1].details.from, 'unrestricted')
  assert.equal(ledger.rows[1].details.to, 'guided')
  assert.equal(ledger.rows[1].details.riskConfirmed, false)
})

test('re-recording the widest level a machine already holds does not need consent', async () => {
  const ledger = recorder()
  const same = await auditedTierChoice({ tier: 'unrestricted', previousTier: 'unrestricted', consent: null, principal: 'x', record: ledger.record, run: () => ({ ok: true, tier: 'unrestricted' }) })
  assert.equal(same.ok, true)
  assert.equal(ledger.rows[1].details.riskConfirmed, false, 'a re-record without a showing must not claim one')
})

/* ---------- the reader ---------- */

const row = (sequence, details, occurredAtMs = 1_700_000_000_000 + sequence) => ({
  sequence, occurredAtMs,
  event: { timestamp: new Date(occurredAtMs).toISOString(), action: TIER_CHOICE_ACTION, target: 'tier:unrestricted', details },
})

test('the reader answers recorded:false for a machine with no confirmed choice on record -- never "confirmed"', () => {
  assert.deepEqual(readConsentState({ findEvents: () => [] }), { ok: true, recorded: false, sequence: null, atMs: null, via: null })
  /* An unconfirmed re-record, and a refused attempt, are on the ledger and
     neither counts. */
  const state = readConsentState({
    findEvents: () => [
      row(5, { outcome: 'ok', riskConfirmed: false }),
      row(6, { outcome: 'refused', riskConfirmed: true }),
    ],
  })
  assert.equal(state.recorded, false)
})

test('the reader finds the newest confirmed choice, whatever order the rows arrive in', () => {
  const state = readConsentState({
    findEvents: () => [
      row(9, { outcome: 'ok', riskConfirmed: true, via: 'settings' }),
      row(3, { outcome: 'ok', riskConfirmed: true, via: 'setup' }),
      row(11, { outcome: 'ok', riskConfirmed: false }),
    ],
  })
  assert.deepEqual(state, { ok: true, recorded: true, sequence: 9, atMs: 1_700_000_000_009, via: 'settings' })
})

test('the reader states its own limits: no reader, or a reader that throws', () => {
  assert.equal(readConsentState({}).ok, false)
  assert.equal(readConsentState({}).code, 'AUDIT_PAYLOAD_ABSENT')
  const thrown = readConsentState({ findEvents: () => { const error = new Error('locked'); error.code = 'AUDIT_LOCKED'; throw error } })
  assert.deepEqual(thrown, { ok: false, code: 'AUDIT_LOCKED', reason: 'The signed record could not be read.' })
})


/* ---------- same trusted main frame, authoritative write boundary ---------- */

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

const concurrencySourceRoot = process.env.TIER_WRITE_SOURCE_ROOT || REPO_ROOT
const concurrencySource = relative => readFileSync(path.join(concurrencySourceRoot, relative), 'utf8')

function tierHandlerFixture({ initialTier = 'unrestricted', holdFirstIntent = false, intentFailure = null, unreadable = false } = {}) {
  const events = [], rows = [], handlers = new Map()
  const intentEntered = deferred(), releaseIntent = deferred()
  let held = false, sequence = 0
  let machine = initialTier === null ? null : {
    tier: initialTier, installRoot: path.resolve('fixture-install'),
    servicesRoot: path.resolve('fixture-services'), nodePath: process.execPath,
    workspaceRoots: [path.resolve('fixture-workspace')],
    machine: { id: 'fixture-machine', label: 'Fixture' }, createdAtMs: 1234,
  }
  const injected = {
    ok: true, root: path.resolve('fixture-engine'),
    machineRecord: {
      TIERS: ['guided', 'standard', 'unrestricted'],
      resolveServicesRoot: () => path.resolve('fixture-services'),
      readMachineRecord: () => {
        if (unreadable) throw Object.assign(new Error('fixture unreadable'), { code: 'BAD_SEAL' })
        return machine && { ...machine }
      },
      buildMachineRecord: input => ({
        ...input, machine: { id: input.machineId, label: input.machineLabel },
      }),
      resolveNodePath: () => process.execPath,
      defaultMachineId: () => 'fixture-machine',
      defaultMachineLabel: () => 'Fixture',
      writeMachineRecord(record) { events.push('write:' + record.tier); machine = { ...record } },
      writeMcpConfig(record) {
        events.push('config:' + record.tier)
        return { document: { mcpServers: {} } }
      },
    },
    workspace: { defaultWorkspacePath: () => path.resolve('fixture-workspace') },
  }
  // Evaluate the complete real module; no filesystem operation may reach disk.
  const setupModule = { exports: {} }
  vm.runInNewContext(concurrencySource('shell/setup-record.cjs'), {
    module: setupModule, __dirname: path.join(concurrencySourceRoot, 'shell'), process,
    require(name) {
      if (name === 'node:fs') return {
        mkdirSync() { events.push('mkdir') },
        rmSync() { throw new Error('unexpected config removal') },
      }
      if (name === './capability-layer.cjs') return { resolveCapabilityRoot: () => null }
      return require_(name)
    },
  }, { filename: 'setup-record.cjs' })
  const setup = setupModule.exports
  const source = concurrencySource('shell/main.cjs')
  const selected = []
  function walk(node) {
    if (!node || typeof node !== 'object') return
    if (node.type === 'FunctionDeclaration' &&
        ['trustedFleetProfileSender', 'withFleetProfileSender', 'fleetFailure'].includes(node.id?.name)) selected.push(node)
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
        && node.callee.object.name === 'ipcMain' && node.callee.property.name === 'handle'
        && node.arguments[0]?.value === 'mc-setup:choose-tier') selected.push(node)
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk)
      else if (value && typeof value === 'object') walk(value)
    }
  }
  walk(parseAst(source))
  assert.equal(selected.length, 4, 'load the actual sender gate, refusal, wrapper and tier handler')
  const shellOrigin = 'https://fixture.invalid'
  const mainFrame = { url: shellOrigin + '/app' }
  const sender = { mainFrame }
  const event = { sender, senderFrame: mainFrame }
  const actualAudit = require_(path.join(concurrencySourceRoot, 'shell/tier-consent.cjs')).auditedTierChoice
  vm.runInNewContext(selected.map(node => source.slice(node.start, node.end)).join('\n'), {
    URL, win: { webContents: sender }, shellOrigin,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    readTierState: () => setup.readTierState({ modules: injected }),
    recordTier: (tier, options) => setup.recordTier(tier, { ...options, modules: injected, documentsDir: null }),
    auditedTierChoice: actualAudit,
    WORKSPACE_ROOT: path.resolve('fixture-dispatch'), CAPABILITY_STATE_ROOT: path.resolve('fixture-state'),
    captureAuditPolicy: () => ({ ok: true, decision: { required: true } }),
    accountPrincipal: () => 'fixture-principal',
    async recordCanonical(action, target, details) {
      events.push(action + ':' + target)
      if (action === TIER_CHOICE_INTENT_ACTION && holdFirstIntent && !held) {
        held = true
        intentEntered.resolve()
        await releaseIntent.promise
      }
      if (action === TIER_CHOICE_INTENT_ACTION && intentFailure) return intentFailure
      const receipt = { ok: true, sequence: ++sequence }
      rows.push({ action, target, details, sequence: receipt.sequence })
      return receipt
    },
  }, { filename: 'main-tier-handler.cjs' })
  return {
    events, rows, event, intentEntered: intentEntered.promise,
    releaseIntent: () => releaseIntent.resolve(),
    tier: () => machine?.tier ?? null,
    choose: (tier, consent = null, senderEvent = event) => handlers.get('mc-setup:choose-tier')(senderEvent, tier, consent),
  }
}

test('same-frame stale unrestricted re-record refuses after a downgrade during its audit await', { timeout: 2000 }, async () => {
  const h = tierHandlerFixture({ holdFirstIntent: true })
  const stale = h.choose('unrestricted')
  await h.intentEntered
  const narrowed = await h.choose('guided')
  assert.equal(narrowed.ok, true)
  assert.equal(h.tier(), 'guided')
  h.releaseIntent()
  const refused = await stale
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'SETUP_TIER_STATE_CHANGED')
  assert.match(refused.reason, /changed/i)
  assert.equal(h.tier(), 'guided', 'the completed downgrade must survive the stale re-record')
  assert.deepEqual(h.events.filter(value => value.startsWith('write:')), ['write:guided'])
  assert.deepEqual(h.events.filter(value => value.startsWith('config:')), ['config:guided'])
  assert.equal(refused.recorded.ok, true, 'a stale write refusal still receives its audit outcome')
  const outcome = h.rows.find(row => row.target === 'tier:unrestricted' && row.action === TIER_CHOICE_ACTION)
  assert.equal(outcome.details.outcome, 'refused')
  assert.equal(outcome.details.code, 'SETUP_TIER_STATE_CHANGED')
  assert.equal(outcome.details.riskConfirmed, false)
  assert.equal(outcome.details.intentSequence, h.rows.find(row => row.target === 'tier:unrestricted' && row.action === TIER_CHOICE_INTENT_ACTION).sequence)
})

test('stale re-record cannot undo downgrade when the intent recorder refuses or is absent', { timeout: 2000 }, async () => {
  for (const code of ['AUDIT_ANCHOR_STALE', 'AUDIT_PAYLOAD_ABSENT']) {
    const h = tierHandlerFixture({ holdFirstIntent: true, intentFailure: { ok: false, code } })
    const stale = h.choose('unrestricted')
    await h.intentEntered
    assert.equal((await h.choose('guided')).ok, true, 'audit failure must not trap the machine in full access')
    h.releaseIntent()
    const result = await stale
    assert.equal(result.ok, false)
    assert.equal(result.code, 'SETUP_TIER_STATE_CHANGED')
    assert.equal(result.recorded.code, code)
    assert.equal(h.tier(), 'guided')
    assert.deepEqual(h.events.filter(value => value.startsWith('write:')), ['write:guided'])
  }
})

test('handler keeps confirmed custom consent, audit order and ordinary unrestricted re-record', async () => {
  const h = tierHandlerFixture({ initialTier: 'guided' })
  const custom = { ...CONSENT, riskText: 'Fixture warning shown by a supported consent surface.' }
  const result = await h.choose('unrestricted', custom)
  assert.equal(result.ok, true)
  assert.equal(h.tier(), 'unrestricted')
  assert.deepEqual(h.events, [
    TIER_CHOICE_INTENT_ACTION + ':tier:unrestricted',
    'write:unrestricted', 'mkdir', 'config:unrestricted',
    TIER_CHOICE_ACTION + ':tier:unrestricted',
  ])
  assert.equal(h.rows[0].details.riskText, custom.riskText)
  assert.equal(h.rows[1].details.riskTextSha256, riskTextSha256(custom.riskText))
  assert.equal(h.rows[1].details.outcome, 'ok')
  assert.equal(h.rows[1].details.intentSequence, h.rows[0].sequence)
  assert.equal((await h.choose('unrestricted')).ok, true)
  assert.equal(h.rows.at(-1).details.riskConfirmed, false, 're-record must not invent consent')
})

test('actual handler rejects unconfirmed enabling and foreign senders before any write or audit', async () => {
  const h = tierHandlerFixture({ initialTier: 'guided' })
  assert.equal((await h.choose('unrestricted')).code, 'SETUP_UNRESTRICTED_UNCONFIRMED')
  const foreignFrame = { sender: h.event.sender, senderFrame: { url: h.event.senderFrame.url } }
  const foreignSender = { sender: { mainFrame: h.event.senderFrame }, senderFrame: h.event.senderFrame }
  for (const event of [foreignFrame, foreignSender]) {
    const result = await h.choose('unrestricted', CONSENT, event)
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'MC_FLEET_PROFILE_SENDER_REFUSED')
  }
  assert.deepEqual(h.events, [])
  assert.equal(h.tier(), 'guided')
})

test('first-run null snapshot can record a confined tier without audit or consent', async () => {
  const h = tierHandlerFixture({ initialTier: null })
  const result = await h.choose('guided')
  assert.equal(result.ok, true)
  assert.equal(h.tier(), 'guided')
  assert.deepEqual(h.events, ['write:guided', 'mkdir', 'config:guided'])
})

test('a stale refusal adds only its audit outcome: no write, folder or assistant config', { timeout: 2000 }, async () => {
  const h = tierHandlerFixture({ holdFirstIntent: true })
  const stale = h.choose('unrestricted')
  await h.intentEntered
  assert.equal((await h.choose('guided')).ok, true)
  const settled = h.events.length
  h.releaseIntent()
  assert.equal((await stale).code, 'SETUP_TIER_STATE_CHANGED')
  assert.deepEqual(h.events.slice(settled), [TIER_CHOICE_ACTION + ':tier:unrestricted'])
  assert.deepEqual(h.events.filter(value => value === 'mkdir'), ['mkdir'], 'only the completed downgrade prepared its folder')
})

test('first-run null snapshot enables full access through the handler only with confirmed consent', async () => {
  const h = tierHandlerFixture({ initialTier: null })
  assert.equal((await h.choose('unrestricted')).code, 'SETUP_UNRESTRICTED_UNCONFIRMED')
  assert.deepEqual(h.events, [])
  const result = await h.choose('unrestricted', CONSENT)
  assert.equal(result.ok, true)
  assert.equal(h.tier(), 'unrestricted')
  assert.deepEqual(h.events, [
    TIER_CHOICE_INTENT_ACTION + ':tier:unrestricted',
    'write:unrestricted', 'mkdir', 'config:unrestricted',
    TIER_CHOICE_ACTION + ':tier:unrestricted',
  ])
  assert.equal(h.rows[0].details.from, null)
  assert.equal(h.rows[1].details.outcome, 'ok')
  assert.equal(h.rows[1].details.riskConfirmed, true)
})

test('an unreadable machine record refuses through the handler and never counts as first run', async () => {
  for (const [tier, consent, audited] of [['guided', null, false], ['unrestricted', CONSENT, true]]) {
    const h = tierHandlerFixture({ initialTier: 'guided', unreadable: true })
    const result = await h.choose(tier, consent)
    assert.equal(result.ok, false, tier)
    assert.equal(result.code, 'BAD_SEAL', tier)
    assert.equal(h.tier(), 'guided')
    assert.deepEqual(h.events, audited
      ? [TIER_CHOICE_INTENT_ACTION + ':tier:unrestricted', TIER_CHOICE_ACTION + ':tier:unrestricted']
      : [], 'no write, folder or assistant config for ' + tier)
    if (audited) {
      assert.equal(h.rows[1].details.outcome, 'refused')
      assert.equal(h.rows[1].details.code, 'BAD_SEAL')
    }
  }
})

/* ---------- remaining preload/channel wiring checks ---------- */

test('main.cjs routes the tier channel through the audited choice and exposes the reader', () => {
  const main = read('shell/main.cjs')
  assert.match(main, /require\('\.\/tier-consent\.cjs'\)/, 'shell/main.cjs does not load the tier consent module')
  assert.match(main, /ipcMain\.handle\('mc-setup:choose-tier'/, 'the tier channel is gone')
  const handler = main.slice(main.indexOf("ipcMain.handle('mc-setup:choose-tier'"))
  const block = handler.slice(0, handler.indexOf('ipcMain.handle(', 10))
  assert.match(block, /auditedTierChoice\(/, 'the tier channel does not go through auditedTierChoice')
  assert.match(block, /recordTier\(/, 'the tier channel no longer writes the machine record')
  assert.match(block, /accountPrincipal\(\)/, 'the record does not carry the principal read in the main process')
  assert.match(main, /ipcMain\.handle\('mc-setup:tier-consent'/, 'the consent reader channel is missing')
})

test('the preload hands the consent through and exposes the reader', () => {
  const preload = read('shell/fleet-profile-preload.cjs')
  assert.match(preload, /chooseTier: \(tier, consent\) => ipcRenderer\.invoke\('mc-setup:choose-tier', tier, consent\)/,
    'mcSetup.chooseTier does not pass the consent to the shell')
  assert.match(preload, /tierConsent: \(\) => ipcRenderer\.invoke\('mc-setup:tier-consent'\)/,
    'mcSetup.tierConsent is not exposed')
})
