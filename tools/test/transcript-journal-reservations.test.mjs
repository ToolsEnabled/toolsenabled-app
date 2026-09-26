import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const { createTranscriptRecoveryJournal } = createRequire(import.meta.url)(
  '../../shell/transcript-recovery-journal.cjs',
)

const CAPACITY_BYTES = 4096
const fixture = async t => {
  const directory = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 't1661-journal-'))
  t.diagnostic(JSON.stringify({ retainedFixture: directory }))
  return directory
}

function assertAccounting(journal) {
  assert.ok(journal.usedBytes + journal.reservedBytes <= journal.capacityBytes,
    'used payload plus live reservations must fit the fixed capacity')
}

function failureIo() {
  let failNext = false
  const base = fs
  return {
    ...base,
    failNextPublication() { failNext = true },
    open: async (file, flags, mode) => {
      const handle = await base.open(file, flags, mode)
      if (flags !== 'r+' || !path.basename(file).startsWith('generation-')) return handle
      return {
        write: async (...args) => {
          if (failNext) {
            failNext = false
            const error = new Error('injected publication failure')
            error.code = 'EIO'
            throw error
          }
          return handle.write(...args)
        },
        sync: (...args) => handle.sync(...args),
        close: (...args) => handle.close(...args),
      }
    },
  }
}

const value = text => ({ text, attachments: [] })

test('concurrent reservations serialize, exact fit is admitted, overflow refuses, and release restores capacity', async t => {
  const directory = await fixture(t)
  const journal = createTranscriptRecoveryJournal({ directory, capacityBytes: CAPACITY_BYTES })
  await journal.ready

  const [large, competing] = await Promise.allSettled([
    journal.reserve('large', 3000),
    journal.reserve('competing', 2000),
  ])
  assert.equal(large.status, 'fulfilled')
  assert.equal(competing.status, 'rejected')
  assert.equal(journal.reservedBytes, 3000)
  assertAccounting(journal)
  assert.equal((await journal.reserve('large', 3000)).reused, true)
  assert.equal(journal.reservedBytes, 3000)

  assert.deepEqual(await journal.releaseReservation('large'), {
    ok: true, reservationId: 'large', releasedBytes: 3000,
    reservedBytes: 0, usedBytes: 0, capacityBytes: CAPACITY_BYTES,
  })
  const exactA = await journal.reserve('exact-a', 2048)
  const exactB = await journal.reserve('exact-b', 2048)
  assert.equal(exactA.reservedBytes, 2048)
  assert.equal(exactB.reservedBytes, CAPACITY_BYTES)
  assert.equal(journal.reservedBytes, CAPACITY_BYTES)
  await assert.rejects(journal.reserve('overflow', 1), error =>
    error.code === 'MC_TRANSCRIPT_RECOVERY_CAPACITY')
  assert.equal(journal.reservedBytes, CAPACITY_BYTES)
  assertAccounting(journal)

  await journal.releaseReservation('exact-a')
  await journal.releaseReservation('exact-b')
  const restored = await journal.reserve('restored', CAPACITY_BYTES)
  assert.equal(restored.reservedBytes, CAPACITY_BYTES)
  assert.equal(journal.reservedBytes, CAPACITY_BYTES)
  await journal.releaseReservation('restored')
  await journal.close()
})

test('a no-token put counts every live claim and cannot steal another reservation', async t => {
  const directory = await fixture(t)
  const journal = createTranscriptRecoveryJournal({ directory, capacityBytes: CAPACITY_BYTES })
  await journal.ready
  await journal.reserve('owner', 3000)

  await assert.rejects(
    journal.put('too-large', value('x'.repeat(1500))),
    error => error.code === 'MC_TRANSCRIPT_RECOVERY_CAPACITY',
  )
  assert.equal((await journal.load()).has('too-large'), false)
  assert.equal(journal.reservedBytes, 3000)
  assertAccounting(journal)

  const ordinary = await journal.put('ordinary', value('small'))
  assert.equal(ordinary.ok, true)
  assert.equal(journal.reservedBytes, 3000)
  assertAccounting(journal)
  await assert.rejects(
    journal.put('stolen', value('small'), { reservationId: 'other', reservedBytes: 3000 }),
    error => error.code === 'MC_TRANSCRIPT_RECOVERY_RESERVATION_UNAVAILABLE',
  )
  assert.equal((await journal.load()).has('stolen'), false)
  assert.equal(journal.reservedBytes, 3000)
  await journal.releaseReservation('owner')
  await journal.close()
})

test('a successful reserved put transfers only its claim and final release is idempotent', async t => {
  const directory = await fixture(t)
  const journal = createTranscriptRecoveryJournal({ directory, capacityBytes: CAPACITY_BYTES })
  await journal.ready
  await journal.reserve('turn-a', 2048)
  await journal.reserve('turn-b', 1024)
  await assert.rejects(
    journal.put('turn-a', value('wrong claim'), { reservationId: 'turn-a', reservedBytes: 1024 }),
    error => error.code === 'MC_TRANSCRIPT_RECOVERY_RESERVATION_MISMATCH',
  )
  assert.equal(journal.reservedBytes, 3072)
  await assert.rejects(
    journal.put('too-large-for-turn-b', value('x'.repeat(1500)), {
      reservationId: 'turn-b', reservedBytes: 1024,
    }),
    error => error.code === 'MC_TRANSCRIPT_RECOVERY_RESERVATION_INSUFFICIENT',
  )
  assert.equal(journal.reservedBytes, 3072)

  const published = await journal.put('turn-a', value('accepted words'), {
    reservationId: 'turn-a', reservedBytes: 2048,
  })
  assert.equal(published.ok, true)
  assert.equal(published.usedBytes, journal.usedBytes)
  assert.equal(journal.reservedBytes, 1024)
  assertAccounting(journal)
  assert.deepEqual(await journal.releaseReservation('turn-a'), {
    ok: true, reservationId: 'turn-a', releasedBytes: 0,
    reservedBytes: 1024, usedBytes: journal.usedBytes, capacityBytes: CAPACITY_BYTES,
  })
  await journal.releaseReservation('turn-b')
  await journal.close()
})

test('failed reserved publication keeps the prior generation and exact claim for replay', async t => {
  const directory = await fixture(t)
  const io = failureIo()
  const journal = createTranscriptRecoveryJournal({ directory, io, capacityBytes: CAPACITY_BYTES })
  await journal.ready
  const prior = value('prior durable words')
  await journal.put('prior', prior)
  await journal.reserve('turn-a', 2048)
  const priorUsedBytes = journal.usedBytes
  io.failNextPublication()

  await assert.rejects(
    journal.put('turn-a', value('replay these exact words'), {
      reservationId: 'turn-a', reservedBytes: 2048,
    }),
    error => error.code === 'MC_TRANSCRIPT_RECOVERY_WRITE_UNAVAILABLE'
      && error.cause?.code === 'EIO',
  )
  assert.equal(journal.usedBytes, priorUsedBytes)
  assert.equal(journal.reservedBytes, 2048)
  assert.deepEqual((await journal.load()).get('prior'), prior)
  assert.equal((await journal.load()).has('turn-a'), false)
  assertAccounting(journal)

  const replayed = await journal.put('turn-a', value('replay these exact words'), {
    reservationId: 'turn-a', reservedBytes: 2048,
  })
  assert.equal(replayed.ok, true)
  assert.equal(journal.reservedBytes, 0)
  assert.deepEqual((await journal.load()).get('prior'), prior)
  assert.deepEqual((await journal.load()).get('turn-a'), value('replay these exact words'))
  assert.deepEqual(await journal.releaseReservation('turn-a'), {
    ok: true, reservationId: 'turn-a', releasedBytes: 0,
    reservedBytes: 0, usedBytes: journal.usedBytes, capacityBytes: CAPACITY_BYTES,
  })
  await journal.close()
})
