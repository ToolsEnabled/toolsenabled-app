/* File hashing and byte counting for release artifacts.
 *
 * Uppercase hex, no separators -- matches PowerShell's Get-FileHash output
 * exactly, which is what the independent verifier measures on receipt. A
 * declaration whose own hash format required translation before a stranger
 * could compare it by eye would be a needless source of "is that the same
 * hash" hesitation at the one moment it matters most.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'

async function sha256Stream(stream) {
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', resolve)
    stream.on('error', reject)
  })
  return hash.digest('hex').toUpperCase()
}

export async function sha256File(filePath) {
  return sha256Stream(createReadStream(filePath))
}

export async function measureFile(filePath) {
  const file = await open(filePath, 'r')
  try {
    const before = await file.stat({ bigint: true })
    const sha256 = await sha256Stream(file.createReadStream({ autoClose: false }))
    const after = await file.stat({ bigint: true })
    const atPath = await stat(filePath, { bigint: true })
    const stableFields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']

    if (stableFields.some((field) => before[field] !== after[field] || after[field] !== atPath[field])) {
      throw new Error(`artifact changed while it was being measured: ${filePath}`)
    }

    return { path: filePath, bytes: Number(after.size), sha256, mtime: after.mtime.toISOString() }
  } finally {
    await file.close()
  }
}

/** Byte-for-byte identity check between two already-measured files -- used to
 * prove a staged copy is identical to what was actually built, not just
 * "probably fine because the copy command didn't error." */
export function sameBytes(measuredA, measuredB) {
  return measuredA.bytes === measuredB.bytes && measuredA.sha256 === measuredB.sha256
}
