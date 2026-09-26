import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createSpawnRecorder } from '../../shell/spawn-record.cjs'

/* A fake keystore, so these run without Electron. It stands in for
   safeStorage's contract only: bytes in, bytes out, and an availability flag.
   It genuinely transforms the bytes rather than prefixing them, so a test that
   asserts the private key is not readable on disk is testing THIS MODULE --
   that it encrypts before writing -- and not the fake's own passthrough. */
function keystore({ available = true, corruptOnRead = false } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (text) => Buffer.from(`enc:${Buffer.from(text, 'utf8').toString('base64')}`, 'utf8'),
    decryptString: (buffer) => {
      if (corruptOnRead) throw new Error('decryption failed')
      const stored = buffer.toString('utf8')
      if (!stored.startsWith('enc:')) throw new Error('not encrypted by this keystore')
      return Buffer.from(stored.slice(4), 'base64').toString('utf8')
    },
  }
}

function workspace(t) {
  const directory = mkdtempSync(join(tmpdir(), 'spawn-record-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('a first run creates a key and records a signed, durable receipt', (t) => {
  const directory = workspace(t)
  const recorder = createSpawnRecorder({ safeStorage: keystore(), directory })

  assert.deepEqual(recorder.availability(), { ok: true, code: 'SPAWN_RECORD_READY' })

  const receipt = recorder.record({ action: 'agent_session_start', sessionId: 'session-1' })
  assert.equal(receipt.sequence, 1)
  assert.equal(receipt.durable, true)
  assert.equal(receipt.signed, true)
  assert.match(receipt.eventHash, /^[a-f0-9]{64}$/)

  // The key is on disk encrypted, never as a readable private key.
  const stored = readFileSync(recorder.keyPath, 'utf8')
  assert.match(stored, /^enc:/)
  assert.doesNotMatch(stored, /BEGIN PRIVATE KEY/)
})

test('records chain, and the chain verifies', (t) => {
  const directory = workspace(t)
  const recorder = createSpawnRecorder({ safeStorage: keystore(), directory })
  recorder.record({ action: 'agent_session_start', sessionId: 'session-1' })
  const second = recorder.record({ action: 'agent_session_start', sessionId: 'session-2' })
  assert.equal(second.sequence, 2)
  assert.deepEqual(recorder.verify(), { ok: true, count: 2 })
})

test('the head survives a restart rather than restarting the sequence', (t) => {
  const directory = workspace(t)
  createSpawnRecorder({ safeStorage: keystore(), directory })
    .record({ action: 'agent_session_start', sessionId: 'session-1' })

  // A second recorder over the same directory is what a relaunch looks like.
  const relaunched = createSpawnRecorder({ safeStorage: keystore(), directory })
  const receipt = relaunched.record({ action: 'agent_session_start', sessionId: 'session-2' })
  assert.equal(receipt.sequence, 2, 'a relaunch must continue the chain, not restart it')
  assert.deepEqual(relaunched.verify(), { ok: true, count: 2 })
})

test('editing a recorded session is detected', (t) => {
  const directory = workspace(t)
  const recorder = createSpawnRecorder({ safeStorage: keystore(), directory })
  recorder.record({ action: 'agent_session_start', sessionId: 'session-1', details: { cwd: 'a' } })
  recorder.record({ action: 'agent_session_start', sessionId: 'session-2', details: { cwd: 'b' } })

  const lines = readFileSync(recorder.ledgerPath, 'utf8').split('\n').filter(Boolean)
  const tampered = JSON.parse(lines[0])
  tampered.details = { cwd: 'somewhere-else' }
  writeFileSync(recorder.ledgerPath, [JSON.stringify(tampered), lines[1]].join('\n') + '\n')

  const result = recorder.verify()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'SPAWN_RECORD_HASH_MISMATCH')
  assert.equal(result.line, 1)
})

test('removing a record is detected', (t) => {
  const directory = workspace(t)
  const recorder = createSpawnRecorder({ safeStorage: keystore(), directory })
  recorder.record({ action: 'agent_session_start', sessionId: 'session-1' })
  recorder.record({ action: 'agent_session_start', sessionId: 'session-2' })

  const lines = readFileSync(recorder.ledgerPath, 'utf8').split('\n').filter(Boolean)
  writeFileSync(recorder.ledgerPath, lines[1] + '\n')

  const result = recorder.verify()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'SPAWN_RECORD_CHAIN_BROKEN')
})

test('no keystore means no receipt, and therefore no spawn', (t) => {
  const directory = workspace(t)
  const recorder = createSpawnRecorder({ safeStorage: keystore({ available: false }), directory })
  assert.deepEqual(recorder.availability(), { ok: false, code: 'SPAWN_RECORD_KEYSTORE_UNAVAILABLE' })
  assert.throws(
    () => recorder.record({ action: 'agent_session_start', sessionId: 'session-1' }),
    /keystore is unavailable/,
  )
  assert.throws(
    () => recorder.verify(),
    /keystore is unavailable/,
    'an absent ledger must not be reported as verified when its signing key cannot be checked',
  )
})

test('an undecryptable key refuses rather than silently starting a new chain', (t) => {
  const directory = workspace(t)
  createSpawnRecorder({ safeStorage: keystore(), directory })
    .record({ action: 'agent_session_start', sessionId: 'session-1' })

  // Regenerating here would orphan every existing signature while reporting
  // success -- the failure mode most worth refusing.
  const broken = createSpawnRecorder({ safeStorage: keystore({ corruptOnRead: true }), directory })
  assert.deepEqual(broken.availability(), { ok: false, code: 'SPAWN_RECORD_KEY_UNREADABLE' })
})

test('the principal is null until an account exists, and is bounded when it does', (t) => {
  const directory = workspace(t)
  const recorder = createSpawnRecorder({ safeStorage: keystore(), directory })
  recorder.record({ action: 'agent_session_start', sessionId: 'session-1' })
  const [entry] = readFileSync(recorder.ledgerPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.equal(entry.principal, null, 'there is no account system yet; the record must not invent one')

  recorder.record({ action: 'agent_session_start', sessionId: 'session-2', principal: 'user-abc' })
  assert.deepEqual(recorder.verify(), { ok: true, count: 2 })
  assert.throws(
    () => recorder.record({ action: 'agent_session_start', sessionId: 'session-3', principal: 'x'.repeat(201) }),
    /principal must be null or a bounded string/,
  )
})
