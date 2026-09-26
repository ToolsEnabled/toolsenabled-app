// The Research page can export a runnable project as a ZIP but has never been
// able to read one back, so an exported project could not be re-opened. These
// tests pin the reader as the exact inverse of the writer in export.mjs: the
// same stored, uncompressed, UTF-8 entries, with every structural claim in the
// archive checked rather than trusted.
import assert from 'node:assert/strict'
import test from 'node:test'
import { zipFiles } from '../../src/benchmark/export.mjs'
import { unzipFiles, ARCHIVE_LIMITS } from '../../src/benchmark/archive.mjs'

const sample = {
  'project.json': JSON.stringify({ format: 'research-benchmark', version: 2 }, null, 2) + '\n',
  'README.md': '# Title\n\nA line with non-ASCII characters: e-acute é, em dash —, han 中.\n',
  'results/evidence.json': '{"projectSha256":"abc"}\n',
  'empty.txt': '',
}

// Replace a name in both the local header and the central directory. The writer
// emits one local header per entry followed by its bytes, then the central
// directory, so an equal-length replacement keeps every recorded offset valid.
function renameSameLength(bytes, from, to) {
  assert.equal(from.length, to.length, 'this helper only substitutes equal-length names')
  const encoder = new TextEncoder(), needle = encoder.encode(from), replacement = encoder.encode(to)
  const copy = bytes.slice()
  let replaced = 0
  for (let index = 0; index + needle.length <= copy.length; index++) {
    let hit = true
    for (let offset = 0; offset < needle.length; offset++) if (copy[index + offset] !== needle[offset]) { hit = false; break }
    if (hit) { copy.set(replacement, index); replaced++ }
  }
  assert.ok(replaced >= 2, 'expected the name in both the local header and the central directory')
  return copy
}

function endOfCentralDirectory(bytes) {
  for (let index = bytes.length - 22; index >= 0; index--) {
    if (bytes[index] === 0x50 && bytes[index + 1] === 0x4b && bytes[index + 2] === 0x05 && bytes[index + 3] === 0x06) return index
  }
  return assert.fail('no end-of-central-directory record')
}

test('a written archive reads back byte for byte', () => {
  assert.deepEqual(unzipFiles(zipFiles(sample)), sample)
})

test('entry order does not change the result', () => {
  const reversed = Object.fromEntries(Object.keys(sample).reverse().map(name => [name, sample[name]]))
  assert.deepEqual(unzipFiles(zipFiles(reversed)), sample)
})

test('a single empty file round-trips', () => {
  assert.deepEqual(unzipFiles(zipFiles({ 'a.txt': '' })), { 'a.txt': '' })
})

test('a flipped content byte is refused rather than returned', () => {
  const corrupted = zipFiles({ 'a.txt': 'hello' }).slice()
  const at = corrupted.indexOf('h'.charCodeAt(0), 30)
  assert.ok(at > 0, 'expected to find the stored content')
  corrupted[at] = corrupted[at] ^ 0xff
  assert.throws(() => unzipFiles(corrupted), /checksum/i)
})

test('a truncated archive is refused', () => {
  const bytes = zipFiles(sample)
  assert.throws(() => unzipFiles(bytes.slice(0, bytes.length - 10)), /archive/i)
})

test('an entry claiming compression is refused, because the writer only stores', () => {
  const patched = zipFiles({ 'a.txt': 'hello' }).slice()
  const view = new DataView(patched.buffer)
  const centralOffset = view.getUint32(endOfCentralDirectory(patched) + 16, true)
  view.setUint16(centralOffset + 10, 8, true)
  assert.throws(() => unzipFiles(patched), /compress|stored/i)
})

test('an unsafe archive path is refused', () => {
  // 'a.txt' and '../.x' are both five bytes, so every recorded offset stays valid.
  assert.throws(() => unzipFiles(renameSameLength(zipFiles({ 'a.txt': 'hello' }), 'a.txt', '../.x')), /path/i)
})

test('a repeated name is refused instead of one entry silently winning', () => {
  assert.throws(() => unzipFiles(renameSameLength(zipFiles({ 'a.txt': 'hello', 'b.txt': 'other' }), 'b.txt', 'a.txt')), /twice|duplicate|repeated/i)
})

test('the reader declares its own bounds', () => {
  assert.ok(ARCHIVE_LIMITS.totalBytes >= 1024 * 1024, 'a real exported project is about 1.1 MB')
  assert.ok(ARCHIVE_LIMITS.entries >= 200, 'a real exported project holds about 70 entries')
  assert.throws(() => unzipFiles(new Uint8Array(ARCHIVE_LIMITS.totalBytes + 1)), /too large|limited/i)
})

test('input that is not an archive at all is refused', () => {
  assert.throws(() => unzipFiles(new TextEncoder().encode('not a zip')), /archive/i)
  assert.throws(() => unzipFiles(new Uint8Array(0)), /archive/i)
})
