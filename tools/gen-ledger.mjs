/** Generate the privacy-minimized owner-request and queue-phase ledger projection. */
import { statSync } from 'node:fs'
import { join } from 'node:path'
import {
  CANONICAL_ROOT,
  available,
  availableEnvelope,
  emitProjection,
  loadReader,
  plainObject,
  source,
  sourceFromResult,
  unavailable,
  unavailableEnvelope,
} from './gen-projection-lib.mjs'

const DOMAIN = 'ledger'
const LEDGER_READER = 'tools/ledger-query.js'
const LEDGER_FILE = 'reports/OWNER-REQUEST-LEDGER.json'
const QUEUE_CORPUS_READER = 'src/lib/build-queue-corpus.js'
const QUEUE_PROJECTION_READER = 'src/lib/build-queue-projection.js'
const QUEUE_ROOT = 'BUILD-QUEUE.md'
const REQUEST_ID = /^R[0-9]{1,4}(?:\.[0-9]+)?$/
const QUESTION_ID = /^Q[0-9]{1,3}$/
const PACKAGE_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/

function observedAt(relativePath) {
  try {
    return new Date(statSync(join(CANONICAL_ROOT, relativePath)).mtimeMs).toISOString()
  } catch {
    return null
  }
}

function ledgerReason(error) {
  if (error?.exitCode === 2) return 'source-missing'
  if (error?.exitCode === 3) return 'source-malformed'
  return 'source-unreadable'
}

function queueReason(error) {
  if (error?.details?.causeCode === 'ENOENT') return 'source-missing'
  if (typeof error?.code === 'string' && (error.code.includes('INVALID') || error.code.includes('MALFORMED') || error.code.includes('DUPLICATE'))) {
    return 'source-malformed'
  }
  return 'source-unreadable'
}

function requestRows(rows) {
  if (!Array.isArray(rows) || rows.length > 5000) throw new TypeError('LEDGER_ROWS_INVALID')
  return rows.map(row => {
    if (!plainObject(row) || typeof row.id !== 'string' || !REQUEST_ID.test(row.id)
      || typeof row.status !== 'string' || row.status.length < 1 || row.status.length > 40) {
      throw new TypeError('LEDGER_ROW_INVALID')
    }
    // ledger-query deliberately treats an absent/non-array gates field as no gates.
    const gates = Array.isArray(row.gates) ? row.gates : []
    if (gates.some(gate => !plainObject(gate))) throw new TypeError('LEDGER_GATE_INVALID')
    return {
      id: row.id,
      status: row.status,
      gateCount: gates.length,
      unmetGateCount: gates.filter(gate => !gate.met).length,
    }
  })
}

function statusClass(status) {
  switch (status) {
    case 'OPEN': return 'open'
    case 'IN-PROGRESS':
    case 'PARTIAL': return 'in-progress'
    case 'BLOCKED': return 'blocked'
    case 'DONE': return 'done'
    default: return 'unknown'
  }
}

function questionRow(phase, packageId) {
  if (!plainObject(phase) || typeof phase.id !== 'string' || !QUESTION_ID.test(phase.id)
    || typeof phase.title !== 'string' || phase.title.length < 1 || phase.title.length > 240
    || typeof phase.status !== 'string' || phase.status.length < 1 || phase.status.length > 120
    || (packageId !== null && (typeof packageId !== 'string' || !PACKAGE_ID.test(packageId) || packageId.length > 80))) {
    throw new TypeError('QUEUE_PHASE_INVALID')
  }
  return {
    id: phase.id,
    title: phase.title,
    status: phase.status,
    statusClass: statusClass(phase.status),
    packageId,
  }
}

function questionsObservation(corpusReader, projectionReader) {
  const sources = [
    sourceFromResult(corpusReader, 'canonical-reader'),
    sourceFromResult(projectionReader, 'canonical-reader'),
  ]
  const rootObservedAt = observedAt(QUEUE_ROOT)
  if (!corpusReader.ok || !projectionReader.ok
    || typeof corpusReader.value?.readQueueCorpus !== 'function'
    || typeof projectionReader.value?.parseQueuePhases !== 'function') {
    const reason = corpusReader.reason || projectionReader.reason || 'source-reader-failed'
    sources.push(source({
      id: 'canonical-build-queue', kind: 'canonical-data', path: QUEUE_ROOT,
      ok: false, observedAt: rootObservedAt, reason,
    }))
    return { observation: unavailable(reason, rootObservedAt), sources }
  }

  try {
    const corpus = corpusReader.value.readQueueCorpus(join(CANONICAL_ROOT, QUEUE_ROOT))
    if (!plainObject(corpus) || typeof corpus.rootText !== 'string' || !Array.isArray(corpus.slices)) {
      throw new TypeError('QUEUE_CORPUS_INVALID')
    }

    // Parse the root and each canonical slice independently.  A slice's record
    // intentionally overwrites a root record with the same Q id.
    const byId = new Map()
    for (const phase of projectionReader.value.parseQueuePhases(corpus.rootText)) {
      const row = questionRow(phase, null)
      byId.set(row.id, row)
    }
    for (const slice of corpus.slices) {
      if (!plainObject(slice) || typeof slice.packageId !== 'string' || typeof slice.text !== 'string') {
        throw new TypeError('QUEUE_SLICE_INVALID')
      }
      for (const phase of projectionReader.value.parseQueuePhases(slice.text)) {
        const row = questionRow(phase, slice.packageId)
        byId.set(row.id, row)
      }
    }
    if (byId.size > 512) throw new TypeError('QUEUE_PHASE_LIMIT')

    const allPaths = [QUEUE_ROOT, ...corpus.slices.map(slice => slice.path)]
    const latestObservedAt = allPaths.map(observedAt).filter(Boolean).sort().at(-1) || null
    sources.push(source({
      id: 'canonical-build-queue', kind: 'canonical-data', path: QUEUE_ROOT,
      ok: true, observedAt: latestObservedAt,
    }))
    return { observation: available([...byId.values()], latestObservedAt), sources }
  } catch (error) {
    const reason = queueReason(error)
    sources.push(source({
      id: 'canonical-build-queue', kind: 'canonical-data', path: QUEUE_ROOT,
      ok: false, observedAt: rootObservedAt, reason,
    }))
    return { observation: unavailable(reason, rootObservedAt), sources }
  }
}

await emitProjection(DOMAIN, async at => {
  const ledgerReader = loadReader(CANONICAL_ROOT, LEDGER_READER, 'canonical-ledger-reader')
  const ledgerObservedAt = observedAt(LEDGER_FILE)
  const sources = [sourceFromResult(ledgerReader, 'canonical-reader')]
  if (!ledgerReader.ok || typeof ledgerReader.value?.readLedger !== 'function') {
    sources.push(source({
      id: 'canonical-owner-ledger', kind: 'canonical-data', path: LEDGER_FILE,
      ok: false, observedAt: ledgerObservedAt, reason: ledgerReader.reason || 'source-reader-failed',
    }))
    return unavailableEnvelope(DOMAIN, ledgerReader.reason || 'source-reader-failed', sources, at)
  }

  let requests
  try {
    requests = requestRows(await ledgerReader.value.readLedger())
    sources.push(source({
      id: 'canonical-owner-ledger', kind: 'canonical-data', path: LEDGER_FILE,
      ok: true, observedAt: ledgerObservedAt,
    }))
  } catch (error) {
    const reason = ledgerReason(error)
    if (reason === 'source-unreadable') {
      process.stderr.write('source-unreadable: the owner-request ledger could not be read; this is not claiming that it is absent.\n')
    }
    sources.push(source({
      id: 'canonical-owner-ledger', kind: 'canonical-data', path: LEDGER_FILE,
      ok: false, observedAt: ledgerObservedAt, reason,
    }))
    return unavailableEnvelope(DOMAIN, reason, sources, at)
  }

  const corpusReader = loadReader(CANONICAL_ROOT, QUEUE_CORPUS_READER, 'canonical-queue-corpus-reader')
  const projectionReader = loadReader(CANONICAL_ROOT, QUEUE_PROJECTION_READER, 'canonical-queue-projection-reader')
  const questions = questionsObservation(corpusReader, projectionReader)
  return availableEnvelope(DOMAIN, { requests, questions: questions.observation }, [...sources, ...questions.sources], at)
})
