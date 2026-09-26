import { canonicalRootForTests } from '../canonical-root.mjs'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const {
  auditedTierChoice,
  checkTierChoice,
  readConsentState,
  readConsentStateAsync,
} = require('../../shell/tier-consent.cjs')

const riskText = 'Full access lets an agent read, change, and delete files outside the workspace.'
const consent = {
  riskShown: true,
  confirmed: true,
  riskText,
  shownAtMs: 1_800_000_000_000,
  via: 'settings',
}

test('the asynchronous consent reader preserves projections, selectors, and refusals', async () => {
  for (const events of [[], null, [
    { sequence: 2, occurredAtMs: 1800000000000, event: { details: { outcome: 'ok', riskConfirmed: true, via: 'settings' } } },
    { sequence: 3, occurredAtMs: 1800000000001, event: { details: { outcome: 'refused', riskConfirmed: true } } },
  ]]) {
    let selected
    const actual = await readConsentStateAsync({ findEvents: async selector => { selected = selector; return events } })
    assert.deepEqual(actual, readConsentState({ findEvents: () => events }))
    assert.equal(selected.target, 'tier:unrestricted')
    assert.equal(selected.limit, 200)
  }
  assert.deepEqual(await readConsentStateAsync({}), readConsentState({}))
  const refusal = () => { throw Object.assign(new Error('untrusted head'), { code: 'AUDIT_ANCHOR_STALE' }) }
  assert.deepEqual(await readConsentStateAsync({ findEvents: async () => refusal() }), readConsentState({ findEvents: refusal }))
})

test('a real choose-tier request is allowed only after confirmed, displayed consent', () => {
  const refused = checkTierChoice({
    tier: 'unrestricted',
    previousTier: 'guided',
    consent: { ...consent, confirmed: false },
  })
  assert.equal(refused.ok, false, 'an unconfirmed widening must be refused')
  assert.equal(refused.code, 'SETUP_UNRESTRICTED_UNCONFIRMED')
  assert.equal(typeof refused.reason, 'string', 'the renderer needs a reason it can present')
  assert.ok(refused.reason.length > 0, 'the refusal reason must not be empty')

  const allowed = checkTierChoice({ tier: 'unrestricted', previousTier: 'guided', consent })
  assert.equal(allowed.ok, true, 'confirmed, displayed consent should admit the widening')
  assert.deepEqual(allowed.consent, consent, 'the admitted decision must carry the normalized evidence')
})

test('widening fails closed when a present ledger cannot record the intent', async () => {
  let writeCalls = 0
  const result = await auditedTierChoice({
    tier: 'unrestricted',
    previousTier: 'guided',
    consent,
    principal: 'account:digest',
    record: () => ({ ok: false, code: 'AUDIT_LOCKED' }),
    run: () => { writeCalls += 1; return { ok: true, tier: 'unrestricted' } },
  })

  assert.equal(writeCalls, 0, 'the permission write must not run without its required intent record')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'SETUP_AUDIT_UNAVAILABLE')
  assert.equal(typeof result.reason, 'string', 'the refusal must explain the unavailable audit')
  assert.ok(result.reason.length > 0, 'the audit refusal reason must not be empty')
})

test('leaving full access remains available when the ledger is unavailable and reports the missing record', async () => {
  let writeCalls = 0
  const result = await auditedTierChoice({
    tier: 'guided',
    previousTier: 'unrestricted',
    principal: 'account:digest',
    record: () => ({ ok: false, code: 'AUDIT_LOCKED' }),
    run: () => { writeCalls += 1; return { ok: true, tier: 'guided' } },
  })

  assert.equal(writeCalls, 1, 'an audit outage must not trap a person at full access')
  assert.equal(result.ok, true)
  assert.equal(result.tier, 'guided')
  assert.deepEqual(result.recorded, { ok: false, code: 'AUDIT_LOCKED' }, 'success must disclose that it was not recorded')
})

test('the consent reader distinguishes both answers and never turns a read failure into one', () => {
  const none = readConsentState({ findEvents: () => [] })
  assert.deepEqual(none, { ok: true, recorded: false, sequence: null, atMs: null, via: null })

  const confirmed = readConsentState({
    findEvents: () => [{
      sequence: 17,
      occurredAtMs: 1_800_000_000_017,
      event: { details: { outcome: 'ok', riskConfirmed: true, via: 'setup' } },
    }],
  })
  assert.deepEqual(confirmed, {
    ok: true,
    recorded: true,
    sequence: 17,
    atMs: 1_800_000_000_017,
    via: 'setup',
  })

  const unreadable = readConsentState({
    findEvents: () => { const error = new Error('busy'); error.code = 'AUDIT_LOCKED'; throw error },
  })
  assert.equal(unreadable.ok, false, 'a read error is not evidence of either consent state')
  assert.equal(unreadable.code, 'AUDIT_LOCKED')
  assert.equal(Object.hasOwn(unreadable, 'recorded'), false, 'a failed read must not claim a definite answer')
  assert.equal(typeof unreadable.reason, 'string')
  assert.ok(unreadable.reason.length > 0, 'a failed read must carry a reason')
})

test('Basic tier change preserves confirmed consent and honest off receipts through a mid-write toggle', async () => {
  const path = require('node:path')
  const operation = require(path.join(canonicalRootForTests({ requireConfigured: true }), 'src/lib/operation-audit.js'))
  let enabled = false, writes = 0, auditWrites = 0
  const options = { loadSettings: () => ({ values: { 'audit.enabled': enabled }, provenance: { 'audit.enabled': { source: 'user' } } }),
    audit: { requireRecord() { auditWrites++; throw Error('unexpected audit'); } } }
  const policy = operation.capturePolicy(options)
  const calls = []
  const record = (action, target, details) => { const receipt = operation.requireRecord(action, target, details, { ...options, auditPolicy: policy }); calls.push(receipt); return receipt }
  const run = () => { writes++; enabled = true; return { ok: true, tier: 'unrestricted' } }
  const denied = await auditedTierChoice({ tier: 'unrestricted', previousTier: 'guided', consent: { ...consent, confirmed: false }, record, run })
  assert.equal(denied.ok, false); assert.equal(writes, 0); assert.equal(calls.length, 0)
  const result = await auditedTierChoice({ tier: 'unrestricted', previousTier: 'guided', consent, record, run })
  assert.equal(result.ok, true); assert.equal(result.tier, 'unrestricted'); assert.equal(writes, 1); assert.equal(auditWrites, 0)
  assert.equal(calls.length, 2)
  assert.equal(result.recorded.disposition, 'not-required')
  assert.equal(result.recorded.signed, false)
  assert.equal(result.recorded.sequence, null)
  assert.deepEqual(result.intentAudit, calls[0])
})
