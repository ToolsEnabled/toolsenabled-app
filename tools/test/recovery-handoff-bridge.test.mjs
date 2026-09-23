// The recovery writer and reader must use the bridge when present, preserving
// the browser-only fallback and refusing failures without refilling settings.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRecoveryHandoffStore } from '../../src/recovery-handoff-store.js'

const HANDOFF = { handoff: 'h'.repeat(43_600), sessionId: 's-1', recoveryId: 'r-1' }

/* The localStorage-shaped face the store has always been given. It records writes
   so a test can prove the settings file was NOT touched. */
function fakeStorage() {
  const written = new Map()
  return {
    written,
    read: key => (written.has(key) ? written.get(key) : null),
    write(key, value) { written.set(key, value); return true },
  }
}

/* window.mcRecovery as the preload exposes it. */
function fakeBridge({ fail = false } = {}) {
  const calls = []
  const files = new Map()
  const at = ({ computerId, nodeId }) => `${computerId}::${nodeId}`
  return {
    calls,
    files,
    async save(request) {
      calls.push(['save', request.nodeId])
      if (fail) return { ok: false, error: { code: 'RECOVERY_WRITE_FAILED' } }
      files.set(at(request), request.record)
      return { ok: true }
    },
    async get(request) {
      calls.push(['get', request.nodeId])
      return { ok: true, record: files.has(at(request)) ? files.get(at(request)) : null }
    },
  }
}

test('WITH a bridge the handoff goes to its own file and NOT into settings', () => {
  const storage = fakeStorage()
  const bridge = fakeBridge()
  const store = createRecoveryHandoffStore({ computerId: 'this-computer', storage, bridge })

  assert.equal(typeof store.saveRecord, 'function', 'a bridged store must offer the async door')

  return store.saveRecord('node-7', HANDOFF).then(saved => {
    assert.equal(saved, true)
    assert.equal(bridge.calls.length, 1, 'the bridge must have been used')
    assert.equal(storage.written.size, 0,
      'NOTHING may reach the settings record — that is the entire point of the redirect')
  })
})

test('a bridged record reads back through the bridge', async () => {
  const store = createRecoveryHandoffStore({ computerId: 'c', storage: fakeStorage(), bridge: fakeBridge() })
  await store.saveRecord('node-1', HANDOFF)
  const got = await store.readRecord('node-1')
  assert.equal(got.handoff, HANDOFF.handoff)
})

test('a node with no record reads as null, not as a failure', async () => {
  const store = createRecoveryHandoffStore({ computerId: 'c', storage: fakeStorage(), bridge: fakeBridge() })
  assert.equal(await store.readRecord('never'), null)
})

test('a bridge that refuses reports failure — it does not silently fall back into settings', async () => {
  /* Falling back would put the bytes in the one place this redirect exists to keep
     them out of, and would do it exactly when the disk is unhappy. The caller
     already treats false as fatal and raises "Could not save the full recovery
     handoff." */
  const storage = fakeStorage()
  const store = createRecoveryHandoffStore({ computerId: 'c', storage, bridge: fakeBridge({ fail: true }) })

  assert.equal(await store.saveRecord('node-1', HANDOFF), false)
  assert.equal(storage.written.size, 0, 'a failed bridge write must NOT be retried into the settings record')
})

test('WITHOUT a bridge the store behaves exactly as it always did', () => {
  /* The compatibility half. Four existing suites construct this store with no
     bridge; they must keep passing unmodified, and a plain browser has no shell. */
  const storage = fakeStorage()
  const store = createRecoveryHandoffStore({ computerId: 'c', storage })

  assert.equal(store.saveRecord, undefined, 'no async door without a bridge, so a caller can detect it')
  assert.equal(store.save('node-1', HANDOFF), true)
  assert.equal(storage.written.size, 1, 'the legacy path still writes through the storage face')
  assert.equal(store.get('node-1').handoff, HANDOFF.handoff)
})

test('the bounds travel with the data, bridged or not', () => {
  const overCap = { ...HANDOFF, handoff: 'x'.repeat(48_001) }
  const bridged = createRecoveryHandoffStore({ computerId: 'c', storage: fakeStorage(), bridge: fakeBridge() })
  const plain = createRecoveryHandoffStore({ computerId: 'c', storage: fakeStorage() })

  assert.equal(plain.save('node-1', overCap), false, 'the legacy path bounded this and still must')
  return bridged.saveRecord('node-1', overCap).then(saved => {
    assert.equal(saved, false, 'moving to disk is not a reason to stop bounding a record')
  })
})

test('an empty or missing handoff is refused on both paths', async () => {
  const bridged = createRecoveryHandoffStore({ computerId: 'c', storage: fakeStorage(), bridge: fakeBridge() })
  const plain = createRecoveryHandoffStore({ computerId: 'c', storage: fakeStorage() })
  for (const bad of [{ handoff: '' }, { handoff: '   ' }, {}]) {
    assert.equal(plain.save('n', bad), false)
    assert.equal(await bridged.saveRecord('n', bad), false)
  }
})

test('a failed bridged read stays distinct from an absent checkpoint', async () => {
  const bridge = fakeBridge()
  bridge.get = async () => ({ ok: false, error: { code: 'RECOVERY_RECORD_UNREADABLE' } })
  const store = createRecoveryHandoffStore({ computerId: 'c', storage: fakeStorage(), bridge })
  await assert.rejects(store.readRecord('n'), /Could not read/)
})

/* T366 -- A HANDOFF WRITTEN BEFORE T377 ITEM 8 IS STILL ON DISK, AND IS STILL
   SENT TO THE MODEL. The producer stopped doubling; the records did not heal
   themselves. These cases call the store with values and read back what a
   replacement session would actually be handed. They never assert how the
   repair is spelled, so a better repair passes them unchanged.

   The shapes below are the producer's, in shell/account-session-recovery.cjs
   (`recoveryHandoff`, `rememberRecoveryText`): the brief header, the recent
   conversation header and the "[message]" person marker. The fuller proof,
   which builds both shapes by RUNNING the pre-fix and current producers, is
   tools/repro/REPRO-LANEC-T366-STORED-HANDOFF-DOUBLED.mjs. */
const OWNER_SAID = 'Ship the renderer audit today.'
const AGENT_SAID = 'Starting with the four providers.'
const handoffText = ({ brief, recent }) =>
  'Continue the same assigned task in a new session.\n\n'
  + `Original task / brief:\n${brief}\n\nRecent conversation:\n${recent}`

const seeded = record => {
  const storage = fakeStorage()
  const store = createRecoveryHandoffStore({ computerId: 'c', storage })
  store.save('node-1', { handoff: record, sessionId: 's-1', recoveryId: 'r-1' })
  return store
}
const timesIn = (text, part) => text.split(part).length - 1

test('a stored handoff that repeats the owner message hands the model one copy', () => {
  const doubled = handoffText({ brief: OWNER_SAID, recent: `\n[message]\n${OWNER_SAID}${AGENT_SAID}` })
  assert.equal(timesIn(doubled, OWNER_SAID), 2, 'the record on disk really does carry it twice')

  const read = seeded(doubled).get('node-1').handoff
  assert.equal(timesIn(read, OWNER_SAID), 1, 'the replacement session is fed the owner message once')
  assert.ok(read.includes(OWNER_SAID), 'and it is still fed the owner message')
  assert.ok(read.includes(AGENT_SAID), 'the reply that followed it is untouched')
})

test('repairing a stored handoff twice gives the same text as repairing it once', () => {
  const doubled = handoffText({ brief: OWNER_SAID, recent: `\n[message]\n${OWNER_SAID}${AGENT_SAID}` })
  const once = seeded(doubled).get('node-1').handoff
  assert.equal(seeded(once).get('node-1').handoff, once, 'idempotent: a healed record does not keep shrinking')
})

test('a handoff that was never doubled comes back byte for byte', () => {
  for (const intact of [
    handoffText({ brief: OWNER_SAID, recent: AGENT_SAID }),
    handoffText({ brief: OWNER_SAID, recent: `${AGENT_SAID}\n[message]\nA later message the brief never held.` }),
    'A handoff in some other shape entirely, with no headers at all.',
  ]) {
    assert.equal(seeded(intact).get('node-1').handoff, intact, 'nothing is removed from a record that was never doubled')
  }
})

test('a tail copy is kept when the brief holds only part of that message', () => {
  // The producer cuts the message that reaches its brief ceiling, so the tail
  // copy is the only whole one. Removing it would truncate the owner's words.
  const cut = 'C'.repeat(15_800)
  const whole = `${cut} and the part that did not fit in the brief.`
  const record = handoffText({ brief: cut.padEnd(16_000, 'C'), recent: `\n[message]\n${whole}` })
  assert.ok(seeded(record).get('node-1').handoff.includes('the part that did not fit in the brief.'),
    'a cut message keeps the only complete copy it has')
})

test('a doubled record read through the bridge is repaired the same way', async () => {
  const doubled = handoffText({ brief: OWNER_SAID, recent: `\n[message]\n${OWNER_SAID}${AGENT_SAID}` })
  const bridge = fakeBridge()
  const store = createRecoveryHandoffStore({ computerId: 'c', storage: fakeStorage(), bridge })
  await store.saveRecord('node-1', { handoff: doubled, sessionId: 's-1', recoveryId: 'r-1' })
  const read = await store.readRecord('node-1')
  assert.equal(timesIn(read.handoff, OWNER_SAID), 1, 'the bridged read is the one a real recovery uses')
  assert.equal(read.sessionId, 's-1', 'the rest of the record is carried unchanged')
})

test('a doubled record on both sides is not reported as two conflicting checkpoints', async () => {
  /* The retained copy is repaired on the way out; a bridge copy that is the
     same record must be compared with it on the same terms, or an identical
     pair reads as a migration conflict and the recovery stops. */
  const doubled = handoffText({ brief: OWNER_SAID, recent: `\n[message]\n${OWNER_SAID}${AGENT_SAID}` })
  const record = { v: 1, handoff: doubled, sessionId: 's-1', recoveryId: 'r-1' }
  const storage = fakeStorage()
  const bridge = fakeBridge()
  bridge.get = async () => ({ ok: true, record })
  const store = createRecoveryHandoffStore({ computerId: 'c', storage, bridge })
  store.save('node-1', { handoff: doubled, sessionId: 's-1', recoveryId: 'r-1' })
  const read = await store.readRecord('node-1')
  assert.equal(timesIn(read.handoff, OWNER_SAID), 1)
})
