import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const { createTranscriptRecoveryJournal } = createRequire(import.meta.url)(
  '../../shell/transcript-recovery-journal.cjs',
)

const CAPACITY_BYTES = 16 * 1024
const HELPER = path.resolve('shell/transcript-recovery-journal.cjs')
const fixture = () => fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 't1647-recovery-'))

const turn = Object.freeze({
  text: 'exact words survive a forced child exit',
  attachments: Object.freeze([
    Object.freeze({
      name: 'diagram.png',
      mime: 'image/png',
      path: 'retained/diagram.png',
      size: 4096,
      sha256: 'a'.repeat(64),
    }),
  ]),
  turnStamp: 'turn-0001',
})

function failureIo(code, { partialGeneration = false, partialReserve = false } = {}) {
  let injectedCalls = 0
  const base = fs
  return {
    ...base,
    injectedCalls: () => injectedCalls,
    open: async (file, flags, mode) => {
      const handle = await base.open(file, flags, mode)
      const generation = path.basename(file)
      let writes = 0
      return {
        write: async (...args) => {
          writes += 1
          const shouldFail = partialReserve
            ? generation === 'generation-0.bin' && flags === 'wx' && writes === 1
            : partialGeneration
            ? generation === 'generation-1.bin' && writes === 2
            : generation === 'generation-0.bin' && flags === 'wx'
          if (!shouldFail) return handle.write(...args)
          injectedCalls += 1
          if (partialGeneration || partialReserve) {
            const [buffer, offset, length, position] = args
            const partial = Math.max(1, Math.floor(length / 2))
            await handle.write(buffer, offset, partial, position)
          }
          const error = new Error('injected ' + code)
          error.code = code
          throw error
        },
        sync: (...args) => handle.sync(...args),
        close: (...args) => handle.close(...args),
      }
    },
  }
}

async function childExit(directory) {
  const script = [
    ';(async () => {',
    "const { createTranscriptRecoveryJournal } = require(process.argv[1])",
    "const directory = process.argv[2]",
    "const journal = createTranscriptRecoveryJournal({ directory, capacityBytes: " + CAPACITY_BYTES + " })",
    "await journal.ready",
    "await journal.put('turn-1', " + JSON.stringify(turn) + ")",
    "process.stdout.write('committed\\n')",
    "setImmediate(() => process.kill(process.pid, 'SIGKILL'))",
    '})().catch(error => { console.error(error); process.exitCode = 1 })',
  ].join('\n')
  const child = spawn(process.execPath, ['-e', script, HELPER, directory], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  return { ...result, stdout, stderr }
}

test('preallocates two bounded generations and reopens exact words after forced child exit', async () => {
  const directory = await fixture()
  const journal = createTranscriptRecoveryJournal({ directory, capacityBytes: CAPACITY_BYTES })
  await journal.ready
  const sizes = await Promise.all([0, 1].map(index =>
    fs.stat(path.join(directory, 'generation-' + index + '.bin')).then(entry => entry.size)))
  assert.deepEqual(sizes, sizes.map(() => 256 + CAPACITY_BYTES + 192))
  assert.ok(sizes.reduce((total, size) => total + size, 0) < 64 * 1024 * 1024)
  await journal.close()

  const result = await childExit(directory)
  assert.equal(result.code, null, result.stderr)
  assert.equal(result.signal, 'SIGKILL', result.stderr)
  assert.match(result.stdout, /committed/)
  assert.equal(result.stderr, '')

  const reopened = createTranscriptRecoveryJournal({ directory, capacityBytes: CAPACITY_BYTES })
  await reopened.ready
  assert.deepEqual((await reopened.load()).get('turn-1'), turn)
  assert.equal(reopened.capacityBytes, CAPACITY_BYTES)
  assert.ok(reopened.usedBytes > 0 && reopened.usedBytes <= CAPACITY_BYTES)
  await reopened.close()
})

test('an interrupted partial generation leaves the prior checksummed generation readable', async () => {
  const directory = await fixture()
  const initial = createTranscriptRecoveryJournal({ directory, capacityBytes: CAPACITY_BYTES })
  await initial.ready
  const prior = { text: 'prior generation stays authoritative', attachments: [] }
  await initial.put('turn-1', prior)
  await initial.close()

  const injected = failureIo('EIO', { partialGeneration: true })
  const failing = createTranscriptRecoveryJournal({
    directory,
    capacityBytes: CAPACITY_BYTES,
    io: injected,
  })
  await failing.ready
  await assert.rejects(
    failing.put('turn-1', { text: 'interrupted replacement', attachments: [] }),
    error => error.code === 'MC_TRANSCRIPT_RECOVERY_WRITE_UNAVAILABLE'
      && error.cause?.code === 'EIO',
  )
  assert.equal(injected.injectedCalls(), 1, 'the failed write is not retried automatically')
  await failing.close()

  const reopened = createTranscriptRecoveryJournal({ directory, capacityBytes: CAPACITY_BYTES })
  await reopened.ready
  assert.deepEqual((await reopened.load()).get('turn-1'), prior)
  await reopened.close()
})

test('capacity refusal preserves the old record and never evicts it', async () => {
  const directory = await fixture()
  const journal = createTranscriptRecoveryJournal({ directory, capacityBytes: 1024 })
  await journal.ready
  const prior = { text: 'old record', attachments: [] }
  await journal.put('turn-1', prior)
  await assert.rejects(
    journal.put('turn-2', { text: 'x'.repeat(5000), attachments: [] }),
    error => error.code === 'MC_TRANSCRIPT_RECOVERY_CAPACITY',
  )
  assert.deepEqual((await journal.load()).get('turn-1'), prior)
  assert.equal((await journal.load()).has('turn-2'), false)
  await journal.close()

  const reopened = createTranscriptRecoveryJournal({ directory, capacityBytes: 1024 })
  await reopened.ready
  assert.deepEqual((await reopened.load()).get('turn-1'), prior)
  assert.equal((await reopened.load()).has('turn-2'), false)
  await reopened.close()
})

test('reserve failures are truthful for ENOSPC, EDQUOT and EIO without a disk fill', async () => {
  for (const code of ['ENOSPC', 'EDQUOT', 'EIO']) {
    const directory = await fixture()
    const injected = failureIo(code)
    const journal = createTranscriptRecoveryJournal({
      directory,
      capacityBytes: CAPACITY_BYTES,
      io: injected,
    })
    await assert.rejects(
      journal.ready,
      error => error.code === 'MC_TRANSCRIPT_RECOVERY_RESERVE_UNAVAILABLE'
        && error.cause?.code === code,
    )
    assert.equal(injected.injectedCalls(), 1, code + ' reserve failure is not retried')
  }
})

test('reopens a blank partial reserve after space returns but preserves nonblank partial extents', async () => {
  const partialDirectory = await fixture()
  const injected = failureIo('ENOSPC', { partialReserve: true })
  const failed = createTranscriptRecoveryJournal({
    directory: partialDirectory,
    capacityBytes: CAPACITY_BYTES,
    io: injected,
  })
  await assert.rejects(
    failed.ready,
    error => error.code === 'MC_TRANSCRIPT_RECOVERY_RESERVE_UNAVAILABLE'
      && error.cause?.code === 'ENOSPC',
  )
  const partialPath = path.join(partialDirectory, 'generation-0.bin')
  const partialStat = await fs.stat(partialPath)
  assert.ok(partialStat.size > 0 && partialStat.size < 256 + CAPACITY_BYTES + 192)
  assert.ok((await fs.readFile(partialPath)).every(byte => byte === 0))

  const recovered = createTranscriptRecoveryJournal({
    directory: partialDirectory,
    capacityBytes: CAPACITY_BYTES,
  })
  await recovered.ready
  assert.deepEqual([...await recovered.load()], [])
  assert.equal((await fs.stat(partialPath)).size, 256 + CAPACITY_BYTES + 192)
  await recovered.close()

  const nonblankDirectory = await fixture()
  const nonblankPath = path.join(nonblankDirectory, 'generation-0.bin')
  await fs.writeFile(nonblankPath, Buffer.from([1, 0, 0]))
  const nonblank = createTranscriptRecoveryJournal({
    directory: nonblankDirectory,
    capacityBytes: CAPACITY_BYTES,
  })
  await assert.rejects(
    nonblank.ready,
    error => error.code === 'MC_TRANSCRIPT_RECOVERY_RESERVE_UNAVAILABLE',
  )
  assert.deepEqual([...await fs.readFile(nonblankPath)], [1, 0, 0])
})

test('remove is a durable tombstone operation and does not delete generation files', async () => {
  const directory = await fixture()
  const journal = createTranscriptRecoveryJournal({ directory, capacityBytes: CAPACITY_BYTES })
  await journal.ready
  await journal.put('turn-1', turn)
  await journal.remove('turn-1')
  assert.equal((await journal.load()).has('turn-1'), false)
  await journal.close()

  const reopened = createTranscriptRecoveryJournal({ directory, capacityBytes: CAPACITY_BYTES })
  await reopened.ready
  assert.equal((await reopened.load()).has('turn-1'), false)
  await reopened.close()
  for (const index of [0, 1]) {
    assert.equal((await fs.stat(path.join(directory, 'generation-' + index + '.bin'))).isFile(), true)
  }
})

test('serializes concurrent puts and removes, and load/close wait for the queue', async () => {
  const directory = await fixture()
  const journal = createTranscriptRecoveryJournal({ directory, capacityBytes: CAPACITY_BYTES })
  await journal.ready

  const firstPut = journal.put('node-a', { text: 'first node', sequence: 1 })
  const secondPut = journal.put('node-b', { text: 'second node', sequence: 2 })
  const snapshotAfterPuts = journal.load()
  const closeAfterPuts = journal.close()
  const [, , loaded, closed] = await Promise.all([firstPut, secondPut, snapshotAfterPuts, closeAfterPuts])
  assert.deepEqual([...loaded.entries()], [
    ['node-a', { text: 'first node', sequence: 1 }],
    ['node-b', { text: 'second node', sequence: 2 }],
  ])
  assert.deepEqual(closed, { ok: true })

  const reopened = createTranscriptRecoveryJournal({ directory, capacityBytes: CAPACITY_BYTES })
  await reopened.ready
  const removeA = reopened.remove('node-a')
  const replaceB = reopened.put('node-b', { text: 'second node updated', sequence: 3 })
  const removeResult = reopened.remove('node-a')
  await Promise.all([removeA, replaceB, removeResult])
  assert.deepEqual([...await reopened.load()], [
    ['node-b', { text: 'second node updated', sequence: 3 }],
  ])
  await reopened.close()
})
