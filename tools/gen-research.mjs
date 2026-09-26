/** Generate the owner-scoped research-suite projection from a directory of curated reports. */
import { statSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  assertRootConfigured,
  available,
  availableEnvelope,
  emitProjection,
  readTextFile,
  requiredRoot,
  sourceFromResult,
  unavailable,
  unavailableEnvelope,
} from './gen-projection-lib.mjs'

const DOMAIN = 'research'
const OWNER_SCOPE = 'local-owner'
const RESEARCH_ROOT = requiredRoot('MC_RESEARCH_ROOT', 'the absolute path of the directory holding the curated reports')
const OWNER_AUTHORIZATION_PATTERN = /\bRESTRICTED-RESEARCH\b|\bLEAN(?:-| )Bench\b/i

const SAFE_REPORTS = Object.freeze([
  {
    id: 'status-report-2026-08-01',
    path: 'status-report-2026-08-01.md',
    summary: 'A point-in-time operational status report on one installation.',
  },
  {
    id: 'coordinator-audit-2026-08-04',
    path: 'coordinator-audit-2026-08-04.md',
    summary: 'An audit of coordinator behavior that groups recurring failures into design problems.',
  },
  {
    id: 'full-audit-2026-08-03',
    path: 'full-audit-2026-08-03.md',
    summary: 'A full-system audit focused on architecture and onboarding, with a ranked findings set.',
  },
  {
    id: 'issues-report-2026-08-04',
    path: 'issues-report-2026-08-04.md',
    summary: 'An account of failures with proposed structural fixes.',
  },
  {
    id: 'plan-audit-2026-08-04',
    path: 'plan-audit-2026-08-04.md',
    summary: 'An independent review of a stabilization plan and the defects to resolve before running it.',
  },
  {
    id: 'report-corpus-research-audit-2026-08-06',
    path: 'report-corpus-research-audit-2026-08-06.md',
    summary: 'A research audit of the report corpus and a roadmap for defensible studies.',
  },
  {
    id: 'handoff-2026-08-07',
    path: 'HANDOFF.md',
    summary: 'A transfer document mapping the current trees and the highest-priority runtime handoff.',
  },
])

const AUTHORIZATION_REASON = 'The report is identified as restricted research material; R198 requires explicit owner authorization before content use.'
const FLAGGED_REPORTS = Object.freeze([
  {
    id: 'restricted-research-corpus-audit-2026-08-06',
    title: 'Research corpus audit — 2026-08-06',
    path: 'restricted/research-corpus-audit-2026-08-06.md',
    authorizationReason: AUTHORIZATION_REASON,
  },
  {
    id: 'restricted-benchmark-iteration-report',
    title: 'Benchmark iteration report',
    path: 'restricted/benchmark-iteration-report.md',
    authorizationReason: AUTHORIZATION_REASON,
  },
  {
    id: 'restricted-research-extension-report',
    title: 'Research extension report',
    path: 'restricted/research-extension-report.md',
    authorizationReason: AUTHORIZATION_REASON,
  },
  {
    id: 'benchmark-audit-markdown',
    title: 'Benchmark audit (Markdown)',
    path: 'BENCHMARK-AUDIT.md',
    authorizationReason: AUTHORIZATION_REASON,
  },
  {
    id: 'benchmark-audit-html',
    title: 'Benchmark audit (HTML)',
    path: 'BENCHMARK-AUDIT.html',
    authorizationReason: AUTHORIZATION_REASON,
  },
  {
    id: 'benchmark-audit-pdf',
    title: 'Benchmark audit (PDF)',
    path: 'BENCHMARK-AUDIT.pdf',
    authorizationReason: AUTHORIZATION_REASON,
  },
  {
    id: 'restricted-product-iteration-report',
    title: 'Product iteration report',
    path: 'restricted/product-iteration-report.md',
    authorizationReason: 'The first-50-lines mechanical screen found restricted research material; owner authorization is required before content use or safe-set reclassification.',
  },
])

const METHOD_NOTES = Object.freeze([
  { id: 'verify-by-rerun', title: 'Verify by re-running', guidance: 'Re-run a claim yourself before treating it as established.' },
  { id: 'true-merge-base', title: 'Use the true merge-base', guidance: 'Diff against the true merge-base when evaluating a change.' },
  { id: 'clean-red-probe', title: 'Require a clean red probe', guidance: 'A red probe on a dirty tree is not evidence.' },
  { id: 'geometry-not-judgment', title: 'Separate geometry from judgment', guidance: 'Probes measure geometry; they do not substitute for judgment.' },
  { id: 'unavailable-not-zero', title: 'Preserve unavailable', guidance: 'Unavailable evidence must not be rendered or analyzed as zero.' },
  { id: 'timeout-is-continuation', title: 'Treat timeout as continuation', guidance: 'A timeout is a continuation state, not a successful result.' },
  { id: 'narrow-generalization', title: 'Generalize narrowly', guidance: 'Default to the narrowest claim supported by the observed incident.' },
])

function slash(value) {
  return String(value).replaceAll('\\', '/')
}

function sourceFailure(result, reason) {
  return { ...result, ok: false, reason, value: null }
}

function safeReport(config) {
  const result = readTextFile(RESEARCH_ROOT, config.path, config.id)
  if (!result.ok) return { ...result, kind: 'desktop-report' }

  const lines = result.value.replace(/\r\n?/g, '\n').split('\n')
  const firstFifty = lines.slice(0, 50).join('\n')
  const titleLine = lines.slice(0, 30).find(line => /^#\s+\S/.test(line.trim()))
  if (OWNER_AUTHORIZATION_PATTERN.test(firstFifty) || !titleLine) {
    return { ...sourceFailure(result, 'source-malformed'), kind: 'desktop-report' }
  }

  const title = titleLine.trim().replace(/^#\s+/, '').trim()
  let stats
  try { stats = statSync(resolve(RESEARCH_ROOT, config.path)) } catch {
    return { ...sourceFailure(result, 'source-unreadable'), kind: 'desktop-report' }
  }
  if (!stats.isFile()
    || !Number.isSafeInteger(stats.size)
    || stats.size < 1
    || Buffer.byteLength(result.value, 'utf8') !== stats.size
    || title.length < 1
    || title.length > 240) {
    return { ...sourceFailure(result, 'source-malformed'), kind: 'desktop-report' }
  }

  return {
    ...result,
    kind: 'desktop-report',
    value: {
      id: config.id,
      title,
      path: slash(resolve(RESEARCH_ROOT, config.path)),
      bytes: stats.size,
      dateObserved: result.observedAt,
      summary: config.summary,
      ownerScope: OWNER_SCOPE,
      source: 'desktop-report',
    },
  }
}

// R198 boundary: metadata-only reports are statted but never opened or read.
function flaggedReport(config) {
  const base = {
    sourceId: config.id,
    path: slash(config.path),
    observedAt: null,
    kind: 'desktop-report-metadata',
  }
  let stats
  try { stats = statSync(resolve(RESEARCH_ROOT, config.path)) } catch (error) {
    return {
      ...base,
      ok: false,
      reason: error?.code === 'ENOENT' ? 'source-missing' : 'source-unreadable',
      value: null,
    }
  }
  if (!stats.isFile() || !Number.isSafeInteger(stats.size) || stats.size < 0 || !Number.isFinite(stats.mtimeMs)) {
    return { ...base, ok: false, reason: 'source-malformed', value: null }
  }
  const observedAt = stats.mtime.toISOString()
  return {
    ...base,
    ok: true,
    reason: null,
    observedAt,
    value: {
      id: config.id,
      title: config.title,
      path: slash(resolve(RESEARCH_ROOT, config.path)),
      bytes: stats.size,
      dateObserved: observedAt,
      ownerScope: OWNER_SCOPE,
      source: 'desktop-report',
      needsOwnerAuthorization: true,
      authorizationReason: config.authorizationReason,
    },
  }
}

await emitProjection(DOMAIN, async at => {
  // Asserted here rather than left to the first read: flaggedReport resolves and
  // stats paths itself instead of going through the library's resolveUnder
  // chokepoint, so an unconfigured root would reach it as a relative segment and
  // come back as an ordinary source-missing.
  assertRootConfigured(RESEARCH_ROOT)
  const results = [
    ...SAFE_REPORTS.map(safeReport),
    ...FLAGGED_REPORTS.map(flaggedReport),
  ]
  const sources = results.map(result => sourceFromResult(result, result.kind))
  const failure = results.find(result => !result.ok)
  if (failure) return unavailableEnvelope(DOMAIN, failure.reason, sources, at)

  return availableEnvelope(DOMAIN, {
    ownerScope: OWNER_SCOPE,
    findingsRegister: available([]),
    failureTaxonomy: unavailable('source-out-of-scope'),
    corpusCatalog: available(results.map(result => result.value)),
    openQuestions: unavailable('source-out-of-scope'),
    methodNotes: available(METHOD_NOTES),
  }, sources, at)
})
