import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ENTRY_LIMIT, FILE_LIMIT, JSON_LIMIT, measureFile, plainPath, readBounded, relativeName } from './adapters/artifact-files.mjs'
import { runOwnedProcess } from './owned-process.mjs'

const SEAL_VERIFIER = fileURLToPath(new URL('../seal-artifact.mjs', import.meta.url))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

function sealFor(root) {
  return path.join(path.dirname(root), `.artifact-seal-${path.basename(root)}.json`)
}

function readSeal(root) {
  try {
    const file = plainPath(sealFor(root), { kind: 'file' })
    const bytes = readBounded(file, JSON_LIMIT)
    return { file, bytes, sha256: hash(bytes) }
  } catch (cause) {
    throw new Error(`Existing artifact seal is unavailable or untrusted: ${cause.message}. Record it after packaging and before runtime checks; this check never creates a seal.`, { cause })
  }
}

async function verifySeal(root) {
  // The existing verifier is a CLI, with unconditional main() on import. Use
  // that real interface rather than duplicating its seal/byte verification or
  // importing it into this process and inheriting its process.exitCode writes.
  const verifier = plainPath(SEAL_VERIFIER, { kind: 'file' })
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^NODE_(?:OPTIONS|PATH)$/i.test(name)))
  const result = await runOwnedProcess(process.execPath, [verifier, '--verify', root], {
    cwd: path.dirname(verifier), env, timeoutMs: 60000, cleanupMs: 5000, maxOutputBytes: 1024 * 1024,
  })
  if (result.code !== 0 || result.terminationConfirmed !== true) {
    const error = new Error(`Artifact seal verification failed before the session: ${result.failureReason || result.output.trim() || 'verifier did not complete successfully'}`)
    error.terminationConfirmed = result.terminationConfirmed
    throw error
  }
}

// Retain the immutability check's directory census: a newly created empty
// captures/ directory is a write even though version-1 artifact seals record
// only files. Fail closed on unreadable or linked entries instead of recording
// an unreadable marker twice and treating it as an unchanged file.
export async function hashInstallTree(root) {
  root = plainPath(root, { kind: 'directory' })
  const entries = new Map()
  let bytes = 0
  async function walk(directory) {
    const listing = await readdir(plainPath(directory, { kind: 'directory' }), { withFileTypes: true })
    for (const entry of listing) {
      if (entries.size >= ENTRY_LIMIT) throw new Error('Install-directory entry budget exceeded')
      const full = plainPath(path.join(directory, entry.name))
      const relative = relativeName(path.relative(root, full).split(path.sep).join('/'))
      if (entry.isDirectory()) {
        entries.set(`${relative}/`, 'DIRECTORY')
        await walk(full)
      } else if (entry.isFile()) {
        const measured = measureFile(full)
        bytes += measured.bytes
        if (bytes > FILE_LIMIT) throw new Error('Install-directory byte budget exceeded')
        entries.set(relative, measured.sha256)
      } else {
        throw new Error(`Install directory contains a non-regular entry: ${relative}`)
      }
    }
    const after = await readdir(plainPath(directory, { kind: 'directory' }))
    if (JSON.stringify(listing.map(entry => entry.name).sort()) !== JSON.stringify(after.sort())) {
      throw new Error('Install directory changed during its baseline census')
    }
  }
  await walk(root)
  return entries
}

export function treeDifferences(before, after) {
  const added = [], removed = [], changed = []
  for (const [file, digest] of after) {
    if (!before.has(file)) added.push(file)
    else if (before.get(file) !== digest) changed.push(file)
  }
  for (const file of before.keys()) if (!after.has(file)) removed.push(file)
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() }
}

function assertSameSeal(root, expected) {
  if (readSeal(root).sha256 !== expected) throw new Error('Artifact seal changed during the session or baseline capture; a replacement seal cannot bless changed input')
}

export async function captureInstallBaseline(artifactDirectory) {
  const root = plainPath(path.resolve(artifactDirectory), { kind: 'directory' })
  const seal = readSeal(root)
  // Fence every artifact input before the verifier child can read the tree.
  const observed = await hashInstallTree(root)
  await verifySeal(root)
  assertSameSeal(root, seal.sha256)

  const parsed = JSON.parse(seal.bytes.toString('utf8'))
  if (!parsed.files || Array.isArray(parsed.files) || typeof parsed.files !== 'object') throw new Error('Artifact seal has unsupported file metadata')
  const recordedFiles = new Map(Object.entries(parsed.files).map(([name, entry]) => {
    if (entry?.kind !== 'file' || !/^[a-f0-9]{64}$/.test(entry.sha256 || '') || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
      throw new Error('Artifact seal has unsupported file metadata')
    }
    return [relativeName(name), entry.sha256]
  }))
  const observedFiles = new Map([...observed].filter(([, digest]) => digest !== 'DIRECTORY'))
  const differences = treeDifferences(recordedFiles, observedFiles)
  if (Object.values(differences).some(names => names.length)) {
    throw new Error(`The sealed baseline differs from the initial census before the session: ${JSON.stringify(differences)}`)
  }
  // Files come from the existing verified seal, never the ambient tree. The
  // version-1 seal does not attest pre-existing empty directories, so their
  // census remains explicitly a before/after runtime check.
  const entries = new Map(recordedFiles)
  for (const [name, digest] of observed) if (digest === 'DIRECTORY') entries.set(name, digest)
  return { root, sealSha256: seal.sha256, entries }
}

export async function compareInstallBaseline(baseline) {
  assertSameSeal(baseline.root, baseline.sealSha256)
  const after = await hashInstallTree(baseline.root)
  assertSameSeal(baseline.root, baseline.sealSha256)
  return { after, ...treeDifferences(baseline.entries, after) }
}
