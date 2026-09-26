'use strict'

const fs = require('node:fs')
const ioDefault = require('node:fs/promises')
const path = require('node:path')
const { createHash } = require('node:crypto')

const HEADER_BYTES = 256
const COMMIT_BYTES = 192
const MAX_CAPACITY_BYTES = 64 * 1024 * 1024
const ZERO_CHUNK = Buffer.alloc(1024 * 1024)
const HEADER_MAGIC = 'toolsenabled-transcript-recovery-v1'
const COMMIT_MAGIC = 'toolsenabled-transcript-recovery-commit-v1'
const IO_FAILURES = new Set(['ENOSPC', 'EDQUOT', 'EIO'])

function failure(code, message, cause) {
  const error = new Error(message)
  error.code = code
  if (cause) error.cause = cause
  return error
}

function validateDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)
      || path.resolve(directory) !== directory
      || directory === path.parse(directory).root
      || directory.includes('\0')) {
    throw new TypeError('Transcript recovery directory must be a normalized absolute non-root path.')
  }
  return directory
}

function validateCapacity(capacityBytes) {
  if (!Number.isSafeInteger(capacityBytes) || capacityBytes < 1024
      || capacityBytes > MAX_CAPACITY_BYTES) {
    throw new RangeError('Transcript recovery capacity must be an integer from 1024 through '
      + MAX_CAPACITY_BYTES + ' bytes.')
  }
  return capacityBytes
}

function validateKey(key) {
  if (typeof key !== 'string' || key.length < 1 || key.length > 512
      || key.includes('\0') || /[\r\n]/.test(key)) {
    throw new TypeError('Transcript recovery keys must be bounded non-empty strings.')
  }
  return key
}

function validateReservationId(reservationId) {
  if (typeof reservationId !== 'string' || reservationId.length < 1 || reservationId.length > 512
      || reservationId.includes('\0') || /[\r\n]/.test(reservationId)) {
    throw new TypeError('Transcript recovery reservation ids must be bounded non-empty strings.')
  }
  return reservationId
}

function validateReservationBytes(reservedBytes, capacityBytes) {
  if (!Number.isSafeInteger(reservedBytes) || reservedBytes < 1
      || reservedBytes > capacityBytes) {
    throw new RangeError('Transcript recovery reservation bytes must be an integer from 1 through '
      + capacityBytes + ' bytes.')
  }
  return reservedBytes
}

function putReservationOptions(options, capacityBytes) {
  if (options === undefined) return null
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Transcript recovery put options must be an object.')
  }
  const hasReservationId = Object.prototype.hasOwnProperty.call(options, 'reservationId')
  const hasReservedBytes = Object.prototype.hasOwnProperty.call(options, 'reservedBytes')
  if (!hasReservationId && !hasReservedBytes) return null
  if (!hasReservationId || !hasReservedBytes) {
    throw new TypeError('Transcript recovery put reservations require reservationId and reservedBytes.')
  }
  return Object.freeze({
    reservationId: validateReservationId(options.reservationId),
    reservedBytes: validateReservationBytes(options.reservedBytes, capacityBytes),
  })
}

function jsonClone(value) {
  let text
  try { text = JSON.stringify(value) } catch (error) {
    throw new TypeError('Transcript recovery values must be JSON-serializable.', { cause: error })
  }
  if (text === undefined) throw new TypeError('Transcript recovery values must be JSON-serializable.')
  return JSON.parse(text)
}

function checksum(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function fixedJson(value, bytes, label) {
  const encoded = Buffer.from(JSON.stringify(value), 'utf8')
  if (encoded.length > bytes) throw failure('MC_TRANSCRIPT_RECOVERY_CORRUPT', label + ' exceeds its fixed bound.')
  const output = Buffer.alloc(bytes)
  encoded.copy(output)
  return output
}

function parseFixedJson(bytes, label) {
  let end = bytes.indexOf(0)
  if (end < 0) end = bytes.length
  if (end === 0) return null
  try { return JSON.parse(bytes.subarray(0, end).toString('utf8')) } catch (error) {
    throw failure('MC_TRANSCRIPT_RECOVERY_CORRUPT', label + ' is not valid JSON.', error)
  }
}

function writeCount(result) {
  const count = typeof result === 'number' ? result : result?.bytesWritten
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw failure('MC_TRANSCRIPT_RECOVERY_IO', 'The recovery journal received a short filesystem write.')
  }
  return count
}

async function writeFully(handle, bytes, position) {
  for (let offset = 0; offset < bytes.length;) {
    const result = await handle.write(bytes, offset, bytes.length - offset, position + offset)
    offset += writeCount(result)
  }
}

async function closeQuietly(handle) {
  if (!handle) return
  await handle.close()
}

async function syncDirectory(io, directory) {
  let handle
  try {
    handle = await io.open(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0))
    await handle.sync()
  } catch (error) {
    if (['EISDIR', 'EINVAL', 'ENOTSUP', 'EPERM'].includes(error?.code)) return
    throw error
  } finally {
    if (handle) await closeQuietly(handle)
  }
}

function isBlank(bytes) {
  for (const byte of bytes) if (byte !== 0) return false
  return true
}

function encodeState(records, revision) {
  const entries = [...records.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => ({ key, value }))
  return Buffer.from(JSON.stringify({ version: 1, revision, records: entries }), 'utf8')
}

function decodeState(payload, expectedRevision) {
  let parsed
  try { parsed = JSON.parse(payload.toString('utf8')) } catch (error) {
    throw failure('MC_TRANSCRIPT_RECOVERY_CORRUPT', 'A recovery generation contains invalid state JSON.', error)
  }
  if (!parsed || parsed.version !== 1 || parsed.revision !== expectedRevision
      || !Array.isArray(parsed.records)) {
    throw failure('MC_TRANSCRIPT_RECOVERY_CORRUPT', 'A recovery generation has an invalid state envelope.')
  }
  const records = new Map()
  for (const entry of parsed.records) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || Object.keys(entry).sort().join(',') !== 'key,value') {
      throw failure('MC_TRANSCRIPT_RECOVERY_CORRUPT', 'A recovery generation has an invalid record.')
    }
    validateKey(entry.key)
    if (records.has(entry.key)) {
      throw failure('MC_TRANSCRIPT_RECOVERY_CORRUPT', 'A recovery generation repeats a record key.')
    }
    records.set(entry.key, jsonClone(entry.value))
  }
  return records
}

function generationPath(directory, generation) {
  return path.join(directory, 'generation-' + generation + '.bin')
}

function totalFileBytes(capacityBytes) {
  return HEADER_BYTES + capacityBytes + COMMIT_BYTES
}

async function reserveFile(io, file, bytes) {
  let stat
  try { stat = await io.stat(file) } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (stat) {
    if (!stat.isFile() || stat.size > bytes) {
      throw failure('MC_TRANSCRIPT_RECOVERY_RESERVE_UNAVAILABLE', 'A recovery extent has the wrong fixed size.')
    }
    if (stat.size === bytes) return
    let existing
    try { existing = Buffer.from(await io.readFile(file)) } catch (error) {
      throw failure('MC_TRANSCRIPT_RECOVERY_RESERVE_UNAVAILABLE',
        'A partial recovery extent could not be inspected safely.', error)
    }
    if (existing.length !== stat.size || !isBlank(existing)) {
      throw failure('MC_TRANSCRIPT_RECOVERY_RESERVE_UNAVAILABLE',
        'A partial recovery extent is nonblank and will not be overwritten.')
    }
  }
  let handle
  try {
    const start = stat?.size || 0
    handle = await io.open(file, stat ? 'r+' : 'wx', 0o600)
    for (let position = start; position < bytes;) {
      const length = Math.min(ZERO_CHUNK.length, bytes - position)
      await writeFully(handle, ZERO_CHUNK.subarray(0, length), position)
      position += length
    }
    await handle.sync()
  } finally {
    await closeQuietly(handle)
  }
}

async function readGeneration(io, file, generation, capacityBytes) {
  let bytes
  try { bytes = Buffer.from(await io.readFile(file)) } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  const expectedBytes = totalFileBytes(capacityBytes)
  if (bytes.length === expectedBytes
      && isBlank(bytes.subarray(0, HEADER_BYTES))
      && isBlank(bytes.subarray(HEADER_BYTES + capacityBytes))) return null
  try {
    if (bytes.length !== expectedBytes) {
      throw failure('MC_TRANSCRIPT_RECOVERY_CORRUPT', 'A recovery generation has the wrong fixed size.')
    }
    const header = parseFixedJson(bytes.subarray(0, HEADER_BYTES), 'Recovery header')
    const commit = parseFixedJson(bytes.subarray(HEADER_BYTES + capacityBytes), 'Recovery commit')
    if (!header || !commit || header.magic !== HEADER_MAGIC || commit.magic !== COMMIT_MAGIC
        || header.version !== 1 || header.generation !== generation
        || commit.generation !== generation || header.revision !== commit.revision
        || header.sha256 !== commit.sha256
        || !Number.isSafeInteger(header.revision) || header.revision < 1
        || !Number.isSafeInteger(header.payloadBytes) || header.payloadBytes < 1
        || header.payloadBytes > capacityBytes
        || !/^[a-f0-9]{64}$/.test(header.sha256)) {
      throw failure('MC_TRANSCRIPT_RECOVERY_CORRUPT', 'A recovery generation has an invalid commit marker.')
    }
    const payload = bytes.subarray(HEADER_BYTES, HEADER_BYTES + header.payloadBytes)
    if (checksum(payload) !== header.sha256) {
      throw failure('MC_TRANSCRIPT_RECOVERY_CORRUPT', 'A recovery generation checksum did not match.')
    }
    return {
      generation,
      revision: header.revision,
      usedBytes: header.payloadBytes,
      records: decodeState(payload, header.revision),
    }
  } catch (error) {
    return { invalid: true, error }
  }
}

async function loadGenerations(io, directory, capacityBytes) {
  const generations = await Promise.all([0, 1].map(index =>
    readGeneration(io, generationPath(directory, index), index, capacityBytes)))
  const valid = generations.filter(item => item && !item.invalid)
  if (!valid.length) {
    const invalid = generations.find(item => item?.invalid)
    if (invalid) throw invalid.error
    return { generation: 1, revision: 0, usedBytes: 0, records: new Map() }
  }
  valid.sort((left, right) => right.revision - left.revision || right.generation - left.generation)
  return valid[0]
}

async function writeGeneration(io, directory, generation, capacityBytes, records, revision) {
  const payload = encodeState(records, revision)
  if (payload.length > capacityBytes) {
    throw failure('MC_TRANSCRIPT_RECOVERY_CAPACITY', 'The recovery record exceeds its fixed capacity.')
  }
  const sha256 = checksum(payload)
  const header = fixedJson({
    magic: HEADER_MAGIC,
    version: 1,
    generation,
    revision,
    payloadBytes: payload.length,
    sha256,
  }, HEADER_BYTES, 'Recovery header')
  const commit = fixedJson({
    magic: COMMIT_MAGIC,
    version: 1,
    generation,
    revision,
    sha256,
  }, COMMIT_BYTES, 'Recovery commit')
  let handle
  try {
    handle = await io.open(generationPath(directory, generation), 'r+')
    await writeFully(handle, header, 0)
    await writeFully(handle, payload, HEADER_BYTES)
    await handle.sync()
    await writeFully(handle, commit, HEADER_BYTES + capacityBytes)
    await handle.sync()
  } finally {
    await closeQuietly(handle)
  }
  await syncDirectory(io, directory)
}

function mapClone(records) {
  return new Map([...records.entries()].map(([key, value]) => [key, jsonClone(value)]))
}

function wrapReserve(error) {
  if (error?.code === 'MC_TRANSCRIPT_RECOVERY_RESERVE_UNAVAILABLE') return error
  if (error?.code === 'MC_TRANSCRIPT_RECOVERY_CORRUPT') return error
  return failure('MC_TRANSCRIPT_RECOVERY_RESERVE_UNAVAILABLE',
    'Transcript recovery persistence could not reserve its fixed storage; provider admission must fail closed.', error)
}

function wrapWrite(error) {
  if (error?.code === 'MC_TRANSCRIPT_RECOVERY_CAPACITY') return error
  if (error?.code === 'MC_TRANSCRIPT_RECOVERY_WRITE_UNAVAILABLE') return error
  const detail = IO_FAILURES.has(error?.code) ? ' (' + error.code + ')' : ''
  return failure('MC_TRANSCRIPT_RECOVERY_WRITE_UNAVAILABLE',
    'Transcript recovery could not publish its reserved generation' + detail + '; the prior generation remains authoritative.', error)
}

function createTranscriptRecoveryJournal({ directory, io = ioDefault, capacityBytes }) {
  validateDirectory(directory)
  validateCapacity(capacityBytes)
  for (const name of ['mkdir', 'stat', 'open', 'readFile']) {
    if (typeof io?.[name] !== 'function') throw new TypeError('Transcript recovery IO is missing ' + name + '.')
  }
  let closed = false
  let records = new Map()
  let generation = 1
  let revision = 0
  let usedBytes = 0
  const reservations = new Map()
  let reservedBytes = 0
  let operationQueue = Promise.resolve()
  const ready = (async () => {
    try {
      await io.mkdir(directory, { recursive: true, mode: 0o700 })
      const directoryStat = await io.stat(directory)
      if (!directoryStat.isDirectory()) throw new Error('Transcript recovery path is not a directory.')
      await reserveFile(io, generationPath(directory, 0), totalFileBytes(capacityBytes))
      await reserveFile(io, generationPath(directory, 1), totalFileBytes(capacityBytes))
      await syncDirectory(io, directory)
      const loaded = await loadGenerations(io, directory, capacityBytes)
      records = loaded.records
      generation = loaded.generation
      revision = loaded.revision
      usedBytes = loaded.usedBytes || 0
      return { ok: true, generation, revision, usedBytes, reservedBytes, capacityBytes }
    } catch (error) {
      throw wrapReserve(error)
    }
  })()
  const ensureOpen = async () => {
    await ready
    if (closed) throw failure('MC_TRANSCRIPT_RECOVERY_CLOSED', 'Transcript recovery journal is closed.')
  }
  const publish = async (nextRecords, reservation) => {
    const nextRevision = revision + 1
    const nextGeneration = generation === 0 ? 1 : 0
    const nextPayload = encodeState(nextRecords, nextRevision)
    if (nextPayload.length > capacityBytes) {
      throw failure('MC_TRANSCRIPT_RECOVERY_CAPACITY', 'The recovery record exceeds its fixed capacity.')
    }
    let claimBytes = 0
    if (reservation) {
      claimBytes = reservations.get(reservation.reservationId)
      if (claimBytes === undefined) {
        throw failure('MC_TRANSCRIPT_RECOVERY_RESERVATION_UNAVAILABLE',
          'The requested transcript recovery reservation is not live.')
      }
      if (claimBytes !== reservation.reservedBytes) {
        throw failure('MC_TRANSCRIPT_RECOVERY_RESERVATION_MISMATCH',
          'The requested transcript recovery reservation size is not current.')
      }
      if (nextPayload.length > usedBytes + claimBytes) {
        throw failure('MC_TRANSCRIPT_RECOVERY_RESERVATION_INSUFFICIENT',
          'The requested transcript recovery reservation is smaller than the publication growth.')
      }
      if (nextPayload.length + reservedBytes - claimBytes > capacityBytes) {
        throw failure('MC_TRANSCRIPT_RECOVERY_CAPACITY',
          'The recovery record plus unrelated reservations exceeds its fixed capacity.')
      }
    } else if (nextPayload.length + reservedBytes > capacityBytes) {
      throw failure('MC_TRANSCRIPT_RECOVERY_CAPACITY',
        'The recovery record plus live reservations exceeds its fixed capacity.')
    }
    try {
      await writeGeneration(io, directory, nextGeneration, capacityBytes, nextRecords, nextRevision)
    } catch (error) {
      throw wrapWrite(error)
    }
    if (reservation) {
      reservations.delete(reservation.reservationId)
      reservedBytes -= claimBytes
    }
    records = mapClone(nextRecords)
    generation = nextGeneration
    revision = nextRevision
    usedBytes = nextPayload.length
    return { ok: true, revision, usedBytes, reservedBytes, capacityBytes }
  }
  const enqueue = operation => {
    const result = operationQueue.then(operation, operation)
    operationQueue = result.catch(() => undefined)
    return result
  }
  const api = {
    ready,
    async load() {
      return enqueue(async () => {
        await ensureOpen()
        return mapClone(records)
      })
    },
    async reserve(reservationId, bytes) {
      validateReservationId(reservationId)
      validateReservationBytes(bytes, capacityBytes)
      return enqueue(async () => {
        await ensureOpen()
        const current = reservations.get(reservationId)
        if (current !== undefined) {
          if (current !== bytes) {
            throw failure('MC_TRANSCRIPT_RECOVERY_RESERVATION_MISMATCH',
              'The transcript recovery reservation id is already bound to another size.')
          }
          return { ok: true, reservationId, reservedBytes, usedBytes, capacityBytes,
            reservationBytes: current, reused: true }
        }
        if (usedBytes + reservedBytes + bytes > capacityBytes) {
          throw failure('MC_TRANSCRIPT_RECOVERY_CAPACITY',
            'The transcript recovery reservation exceeds its fixed capacity.')
        }
        reservations.set(reservationId, bytes)
        reservedBytes += bytes
        return { ok: true, reservationId, reservedBytes, usedBytes, capacityBytes,
          reservationBytes: bytes, reused: false }
      })
    },
    async releaseReservation(reservationId) {
      validateReservationId(reservationId)
      return enqueue(async () => {
        await ensureOpen()
        const releasedBytes = reservations.get(reservationId) || 0
        if (releasedBytes) {
          reservations.delete(reservationId)
          reservedBytes -= releasedBytes
        }
        return { ok: true, reservationId, releasedBytes, reservedBytes, usedBytes, capacityBytes }
      })
    },
    async put(key, value, options) {
      validateKey(key)
      const cloned = jsonClone(value)
      const reservation = putReservationOptions(options, capacityBytes)
      return enqueue(async () => {
        await ensureOpen()
        const next = mapClone(records)
        next.set(key, cloned)
        return publish(next, reservation)
      })
    },
    async remove(key) {
      validateKey(key)
      return enqueue(async () => {
        await ensureOpen()
        if (!records.has(key)) {
          return { ok: true, removed: false, revision, usedBytes, reservedBytes, capacityBytes }
        }
        const next = mapClone(records)
        next.delete(key)
        const result = await publish(next)
        return { ...result, removed: true }
      })
    },
    async close() {
      return enqueue(async () => {
        await ready
        closed = true
        return { ok: true }
      })
    },
  }
  Object.defineProperties(api, {
    capacityBytes: { enumerable: true, get: () => capacityBytes },
    usedBytes: { enumerable: true, get: () => usedBytes },
    reservedBytes: { enumerable: true, get: () => reservedBytes },
  })
  return api
}

module.exports = {
  COMMIT_BYTES,
  HEADER_BYTES,
  MAX_CAPACITY_BYTES,
  createTranscriptRecoveryJournal,
}
