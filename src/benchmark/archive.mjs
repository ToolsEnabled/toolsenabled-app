// Reader for the archives export.mjs writes. The writer emits deterministic,
// UTF-8, uncompressed ZIP entries with no platform tools or dependencies, so
// the reader is its exact inverse and needs none either. Every structural claim
// the archive makes about itself is checked against the bytes actually present:
// an archive is untrusted input, not a description of itself.
import { invariant } from './prompts.mjs'
import { safePath } from './study.mjs'
import { crc32 } from './export.mjs'

export const ARCHIVE_LIMITS = { totalBytes: 64 * 1024 * 1024, entries: 4096, fileBytes: 32 * 1024 * 1024 }

const LOCAL_SIGNATURE = 0x04034b50, CENTRAL_SIGNATURE = 0x02014b50, END_SIGNATURE = 0x06054b50
const STORED = 0, LOCAL_HEADER = 30, CENTRAL_HEADER = 46, END_RECORD = 22

function decode(bytes, label) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { throw new Error(`This project archive holds ${label} that is not valid UTF-8 text.`) }
}

// The writer appends no archive comment, so the end record is normally the last
// 22 bytes; scanning back still accepts one and proves where the record ends.
function endRecordOffset(bytes) {
  for (let index = bytes.length - END_RECORD; index >= 0 && index >= bytes.length - END_RECORD - 0xffff; index--) {
    if (new DataView(bytes.buffer, bytes.byteOffset + index).getUint32(0, true) !== END_SIGNATURE) continue
    const view = new DataView(bytes.buffer, bytes.byteOffset + index)
    if (index + END_RECORD + view.getUint16(20, true) === bytes.length) return index
  }
  throw new Error('This is not a readable project archive: its end record is missing or truncated.')
}

export function unzipFiles(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  invariant(bytes.length <= ARCHIVE_LIMITS.totalBytes, `Project archives are limited to ${ARCHIVE_LIMITS.totalBytes} bytes.`)
  invariant(bytes.length >= END_RECORD, 'This is not a readable project archive: it is too short to hold an end record.')
  const end = endRecordOffset(bytes), endView = new DataView(bytes.buffer, bytes.byteOffset + end)
  const entries = endView.getUint16(10, true), directorySize = endView.getUint32(12, true), directoryStart = endView.getUint32(16, true)
  invariant(entries === endView.getUint16(8, true), 'This is not a readable project archive: its entry counts disagree.')
  invariant(entries <= ARCHIVE_LIMITS.entries, `Project archives are limited to ${ARCHIVE_LIMITS.entries} entries.`)
  invariant(directoryStart + directorySize === end, 'This is not a readable project archive: its directory does not end where the archive says.')

  const files = {}
  let cursor = directoryStart, total = 0
  for (let index = 0; index < entries; index++) {
    invariant(cursor + CENTRAL_HEADER <= end, 'This is not a readable project archive: a directory entry runs past its directory.')
    const entry = new DataView(bytes.buffer, bytes.byteOffset + cursor)
    invariant(entry.getUint32(0, true) === CENTRAL_SIGNATURE, 'This is not a readable project archive: a directory entry has no signature.')
    invariant(entry.getUint16(10, true) === STORED, 'This project archive declares a compressed entry; only stored entries are read.')
    const crc = entry.getUint32(16, true), stored = entry.getUint32(20, true), size = entry.getUint32(24, true)
    const nameLength = entry.getUint16(28, true), extraLength = entry.getUint16(30, true), commentLength = entry.getUint16(32, true)
    const localStart = entry.getUint32(42, true)
    invariant(stored === size, 'This project archive declares an entry whose stored and actual sizes differ; only stored entries are read.')
    invariant(size <= ARCHIVE_LIMITS.fileBytes, `Files inside a project archive are limited to ${ARCHIVE_LIMITS.fileBytes} bytes.`)
    invariant(cursor + CENTRAL_HEADER + nameLength + extraLength + commentLength <= end, 'This is not a readable project archive: a directory entry runs past its directory.')
    const name = decode(bytes.subarray(cursor + CENTRAL_HEADER, cursor + CENTRAL_HEADER + nameLength), 'a file name')
    invariant(safePath(name), `Invalid archive path: ${name}.`)
    invariant(!Object.prototype.hasOwnProperty.call(files, name), `This project archive names ${name} twice.`)

    invariant(localStart + LOCAL_HEADER <= directoryStart, 'This is not a readable project archive: an entry points outside its own data.')
    const local = new DataView(bytes.buffer, bytes.byteOffset + localStart)
    invariant(local.getUint32(0, true) === LOCAL_SIGNATURE, 'This is not a readable project archive: an entry header has no signature.')
    invariant(local.getUint16(8, true) === STORED, 'This project archive declares a compressed entry; only stored entries are read.')
    const localNameLength = local.getUint16(26, true), localExtraLength = local.getUint16(28, true)
    invariant(localNameLength === nameLength, `This project archive disagrees with itself about the name of ${name}.`)
    const start = localStart + LOCAL_HEADER + localNameLength + localExtraLength
    invariant(start + size <= directoryStart, 'This is not a readable project archive: an entry runs past its own data.')
    invariant(decode(bytes.subarray(localStart + LOCAL_HEADER, localStart + LOCAL_HEADER + localNameLength), 'a file name') === name,
      `This project archive disagrees with itself about the name of ${name}.`)
    invariant(local.getUint32(14, true) === crc && local.getUint32(22, true) === size, `This project archive disagrees with itself about the contents of ${name}.`)

    const data = bytes.subarray(start, start + size)
    invariant(crc32(data) === crc, `The checksum for ${name} does not match its contents in this project archive.`)
    total += size
    invariant(total <= ARCHIVE_LIMITS.totalBytes, `Project archives are limited to ${ARCHIVE_LIMITS.totalBytes} bytes.`)
    files[name] = decode(data, `the contents of ${name}`)
    cursor += CENTRAL_HEADER + nameLength + extraLength + commentLength
  }
  invariant(cursor === end, 'This is not a readable project archive: its directory holds more entries than it declares.')
  return files
}
