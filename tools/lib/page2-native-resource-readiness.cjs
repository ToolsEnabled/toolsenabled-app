'use strict'

// QA observes the real governor before the existing visible Start input. An
// allowed observation is not a reservation: the product still owns its later
// admission/revalidation, and a later refusal remains a failed native case.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const DEFAULT_TIMEOUT_MS = 60000
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

function snapshotIdentity(snapshot) {
  assert.equal(snapshot?.ok, true, 'The actual resource host must answer successfully')
  assert.ok(typeof snapshot.bootId === 'string' && snapshot.bootId.length > 0 && snapshot.bootId.length <= 128,
    'The actual resource observation must name its app monitor')
  assert.ok(snapshot.settings && typeof snapshot.settings === 'object' && !Array.isArray(snapshot.settings),
    'The actual resource observation must retain its configured policy')
  assert.equal(snapshot.mode, snapshot.settings.mode, 'The observed resource policy must match its settings')
  assert.equal(typeof snapshot.admission?.ok, 'boolean', 'The resource host must return its actual admission decision')
  assert.deepEqual(snapshot.admission.state?.settings, snapshot.settings,
    'The admission must use the observed configured policy')
  assert.equal(snapshot.admission.state?.mode, snapshot.mode, 'A QA read cannot request a privileged admission mode')
  if (!snapshot.admission.ok) {
    assert.match(snapshot.admission.code || '', /^[A-Z][A-Z0-9_]{0,127}$/, 'A resource refusal must retain its actual code')
    assert.ok(typeof snapshot.admission.reason === 'string' && snapshot.admission.reason.trim(),
      'A resource refusal must retain its actual reason')
  }
  return { bootId: snapshot.bootId, policySha256: hash(JSON.stringify(snapshot.settings)) }
}

async function boundedRead(read, milliseconds) {
  let timer
  try {
    return await Promise.race([Promise.resolve().then(read), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('The actual resource status read did not settle within its bounded deadline')), milliseconds)
    })])
  } finally { clearTimeout(timer) }
}

async function waitForResourceAdmission({ read, record = async () => {}, now = () => performance.now(), sleep = pause,
  timeoutMs = DEFAULT_TIMEOUT_MS, pollMs = 1000, readTimeoutMs = 5000 } = {}) {
  assert.equal(typeof read, 'function')
  assert.equal(typeof record, 'function')
  for (const [value, maximum] of [[timeoutMs, 120000], [pollMs, 5000], [readTimeoutMs, 15000]]) {
    assert.ok(Number.isInteger(value) && value > 0 && value <= maximum, 'Resource observation waits must remain bounded')
  }
  const began = now(), deadline = began + timeoutMs
  let identity = null, last = null, attempts = 0
  const expired = () => new Error(`Resource admission remained refused before native input after ${timeoutMs}ms: ${last?.admission?.code || 'AGENT_RESOURCE_UNKNOWN'}: ${last?.admission?.reason || 'No accepted resource observation.'}`)
  while (true) {
    const remaining = deadline - now()
    if (remaining <= 0) throw expired()
    attempts++
    let snapshot
    try {
      const result = await boundedRead(read, Math.min(remaining, readTimeoutMs))
      const serialized = JSON.stringify(result)
      assert.ok(typeof serialized === 'string' && serialized.length <= 65536, 'The resource observation must be a bounded JSON reply')
      snapshot = JSON.parse(serialized)
    } catch (error) {
      await record({ attempt: attempts, elapsedMs: Math.max(0, now() - began), error: error.message })
      throw error
    }
    await record({ attempt: attempts, elapsedMs: Math.max(0, now() - began), snapshot })
    const observed = snapshotIdentity(snapshot)
    if (!identity) identity = observed
    else assert.deepEqual(observed, identity, 'The actual app monitor and resource policy must remain unchanged while QA waits')
    last = snapshot
    if (now() >= deadline) throw new Error('The resource observation deadline expired before native input')
    if (snapshot.admission.ok) return { ...identity, attempts, elapsedMs: Math.max(0, now() - began), snapshot }
    await sleep(Math.min(pollMs, deadline - now()))
  }
}

function waitForNativeResourceReady(context, caseId) {
  assert.match(caseId, /^[a-z][a-z0-9-]+$/)
  return context.step(`resource-ready-${caseId}`, () => waitForResourceAdmission({
    read: () => context.page.evaluate(() => window.mcResources.status({ provider: 'codex' })),
    record: observation => context.step(`resource-read-${caseId}-${observation.attempt}`, async () => observation),
  }))
}

module.exports = { DEFAULT_TIMEOUT_MS, waitForResourceAdmission, waitForNativeResourceReady }
