import fs from 'node:fs'
import path from 'node:path'
import { userInfo } from 'node:os'
import { createHash } from 'node:crypto'
import { readinessDigest } from '../../lib/release-readiness.mjs'

const LIMIT = 2 * 1024 * 1024
const DIGEST = /^[a-f0-9]{64}$/i
const REF = /^[a-f0-9]{40}$/i
const PROFILE = userInfo().homedir

function inside(root, target) {
  const relative = path.relative(path.resolve(root), target)
  return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

// Storage validation only, not a qualification authority. Never follow links
// or use an inherited account destination. Parents must already be private,
// explicit directories; this helper does not create or relax their ACLs.
export function assertPrivateReadinessPath(file, { excludedRoots = [], existing = false } = {}) {
  if (typeof file !== 'string' || !file.trim() || (process.platform === 'win32' &&
      (/^[\\/]{2}/.test(file) || /:/.test(file.replace(/^[a-z]:/i, '')) ||
       file.split(/[\\/]/).some(part => /[. ]$/.test(part) && part !== '.' && part !== '..')))) {
    throw new Error('readiness path is missing or uses an alternate/device spelling')
  }
  const resolved = path.resolve(file)
  const fence = process.platform === 'win32' ? PROFILE : path.parse(resolved).root
  if (!inside(fence, resolved) || resolved === fence) throw new Error('readiness path leaves the permitted profile')
  if (excludedRoots.some(root => inside(root, resolved))) {
    throw new Error('raw readiness evidence must stay outside candidate staging, source and build worktrees')
  }
  let cursor = fence
  if (!fs.lstatSync(cursor).isDirectory() || fs.lstatSync(cursor).isSymbolicLink()) throw new Error('readiness profile root is not a plain directory')
  const components = path.relative(fence, resolved).split(path.sep)
  for (const component of components.slice(0, -1)) {
    cursor = path.join(cursor, component)
    const stat = fs.lstatSync(cursor)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('readiness parent must be an existing, non-linked private directory')
  }
  let stat
  try { stat = fs.lstatSync(resolved) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  if (existing) {
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size <= 0 || stat.size > LIMIT) {
      throw new Error('readiness input must be one bounded, non-linked private file')
    }
  } else if (stat) {
    throw new Error('readiness output already exists; choose a new private filename (no overwrite)')
  }
  return resolved
}

export function assertReadinessHandoffPaths({ inputPath, outputPath, excludedRoots = [] }) {
  if (!inputPath && !outputPath) throw new Error('--readiness-output is required when producing a new receipt; choose an existing private evidence directory')
  return {
    inputPath: inputPath ? assertPrivateReadinessPath(inputPath, { excludedRoots, existing: true }) : undefined,
    outputPath: outputPath ? assertPrivateReadinessPath(outputPath, { excludedRoots }) : undefined,
  }
}

function parseMatchingReceipt(bytes, receipt) {
  if (!bytes.length || bytes.length > LIMIT) throw new Error('private readiness receipt exceeds its size budget or is empty')
  const parsed = JSON.parse(bytes.toString('utf8'))
  if (readinessDigest(parsed) !== readinessDigest(receipt)) throw new Error('private readiness receipt changed or lost fields in serialization')
}

// The caller must first earn/validate readiness using the fixed production
// registry. This helper preserves JSON evidence, never creates a green verdict.
// Input copies retain their exact bytes; producer results are serialized once.
// A failed write is not replaced or removed automatically: choose another path.
export function preserveReadinessReceipt(receipt, { inputPath, outputPath, excludedRoots = [] }) {
  const paths = assertReadinessHandoffPaths({ inputPath, outputPath, excludedRoots })
  const bytes = paths.inputPath
    ? fs.readFileSync(paths.inputPath)
    : Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  parseMatchingReceipt(bytes, receipt)
  let destination = paths.inputPath
  if (paths.outputPath) {
    assertPrivateReadinessPath(paths.outputPath, { excludedRoots })
    const handle = fs.openSync(paths.outputPath, 'wx', 0o600)
    try {
      fs.writeFileSync(handle, bytes)
      fs.fsyncSync(handle)
    } finally { fs.closeSync(handle) }
    destination = paths.outputPath
  }
  assertPrivateReadinessPath(destination, { excludedRoots, existing: true })
  const persisted = fs.readFileSync(destination)
  if (!bytes.equals(persisted)) throw new Error('private readiness receipt bytes changed during handoff')
  parseMatchingReceipt(persisted, receipt)
  return Object.freeze({ path: destination, sha256: createHash('sha256').update(persisted).digest('hex'), bytes: persisted.length })
}

// Only allowlisted portable identities reach public declaration facts. This
// digest identifies the untouched receipt object, not a sanitized substitute.
// It is informational, cannot be consumed as readiness, and says nothing about
// validity when a diagnostic renderer was given unverified caller metadata.
export function publicReadinessSummary(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return undefined
  const summary = {
    schema: 'toolsenabled.release-qualification-summary',
    schemaVersion: 1,
    authority: 'informational-only; the original private receipt must be verified separately',
    receiptObjectSha256: readinessDigest(receipt),
  }
  if (['toolsenabled', 'scribe', 'web-editor', 'presentation-suite'].includes(receipt.product)) summary.product = receipt.product
  if (DIGEST.test(receipt.contractSha256 || '')) summary.contractSha256 = receipt.contractSha256
  if (/^[a-f0-9-]{36}$/i.test(receipt.run?.id || '')) summary.runId = receipt.run.id
  if (receipt.subject && typeof receipt.subject === 'object') summary.subjectSha256 = readinessDigest(receipt.subject)
  const artifact = receipt.subject?.artifact
  if (DIGEST.test(artifact?.sha256 || '') && Number.isSafeInteger(artifact?.bytes) && artifact.bytes > 0) {
    summary.artifact = { sha256: artifact.sha256, bytes: artifact.bytes }
  }
  const sourceRefs = {}
  for (const key of ['app', 'engine']) if (REF.test(receipt.subject?.sourceRefs?.[key] || '')) sourceRefs[key] = receipt.subject.sourceRefs[key]
  if (Object.keys(sourceRefs).length) summary.sourceRefs = sourceRefs
  return summary
}
