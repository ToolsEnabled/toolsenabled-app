// Shared by tools/test/research-benchmark-export-bytes.test.mjs and
// tools/research-benchmark-export-baseline.mjs so the gate and the tool that
// re-freezes it cannot disagree about what "the exported bytes" means.
//
// Two fixtures, because one does not cover the export. The generic starter is
// a pure-core study (arithmetic tasks, replay adapter), and the Lean starter
// drives the Lean/trading vertical through the same compiler. export.mjs calls
// leanProjectFiles, leanContractId, attributionsMarkdown and provenanceDocument
// unconditionally, so both fixtures cross those four call sites; only the Lean
// fixture exercises the vertical's own compiled output.
import { readFile, readdir } from 'node:fs/promises'
import { createReviewRecord, sha256 } from '../../../src/benchmark/prompts.mjs'
import { RUNTIME_FILES, bindRuntimeSources, freezeStudy } from '../../../src/benchmark/study.mjs'
import { genericStarter, newExperimentDraft } from '../../../src/benchmark/starters.mjs'
import { leanStarter } from '../../../src/benchmark/lean.mjs'
import { bindLeanReview } from '../../../src/benchmark/lean-codegen.mjs'
import { projectFiles } from '../../../src/benchmark/export.mjs'
import { developmentDraft } from './research-benchmark-development.mjs'

export const FIXTURES = ['generic', 'lean']

async function runtimeSources() {
  return Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file =>
    [file, await readFile(new URL('../../../src/benchmark/' + file, import.meta.url), 'utf8')])))
}

// The Lean starter sets requireReview, so freezing it needs review records for
// every catalog bundle. The wording is the same synthetic marker the activation
// suite uses; it is apparatus, not an approval of a real study.
//
// createReviewRecord defaults `at` to new Date().toISOString(). Left at the
// default the review timestamp moves every call, and because reviews.json feeds
// project.sha256 it drags specification.json, README.md, CITATION.*,
// readiness/contract.json and manifest.json with it. The fixture pins the
// instant so the gate measures the compiler and not the clock.
const REVIEWED_AT = '2026-09-18T00:00:00.000Z'

async function freezeLean(sources) {
  const spec = await bindLeanReview(await bindRuntimeSources(developmentDraft(leanStarter()), sources), sources)
  spec.reviews = await Promise.all(spec.catalog.map(bundle =>
    createReviewRecord(spec.catalog, bundle.id, 'SYNTHETIC SELECTED-INPUT APPARATUS ONLY', { at: REVIEWED_AT })))
  return freezeStudy(spec)
}

async function freezeGeneric(sources) {
  return freezeStudy(await bindRuntimeSources(newExperimentDraft(genericStarter(), { initializePopulation: true }), sources))
}

export async function exportFixture(fixture) {
  const sources = await runtimeSources()
  const project = fixture === 'lean' ? await freezeLean(sources) : await freezeGeneric(sources)
  return { files: await projectFiles(project, sources), project, sources }
}

// project.json and manifest.json both cover the bytes of the runtime source
// files, so both move whenever src/benchmark/*.mjs is edited at all. They are
// compared structurally by projectShape instead of byte for byte.
const SOURCE_TRACKING = new Set(['project.json', 'manifest.json'])

export function compiledArtifacts(files) {
  return Object.keys(files).filter(name => !RUNTIME_FILES.includes(name) && !SOURCE_TRACKING.has(name)).sort()
}

// The STUDY CONTENT the project describes, with every derived digest removed.
//
// A digest is not independent data: it is computed from something else in the
// project plus the runtime source bytes. Runtime digests turned out to live in
// at least five places -- project.sha256, spec.runtimeSources, each catalog
// bundle's hooks.sourceHashes, each review record, the readiness contract's
// bindings, and every compiled composition node's bundle reference -- so a
// hand-written exclusion list kept missing one and this check went red for any
// edit to any src/benchmark module, which is exactly what it must NOT do.
//
// Dropping every sha256/*Sha256 key instead is both simpler and stricter to
// reason about: what remains is the study's own content -- ids, prompt text,
// semantics, parameters, expected answers, conditions, protocol, schedule,
// reviewers and decisions. A real change to the study moves that content, so
// this check still sees it (proved by mutation in the report); a change to the
// compiler's own source moves only digests, so this check correctly ignores it.
// Byte-for-byte digest stability is test A's job, over the compiled artifacts.
function withoutDigests(value) {
  if (Array.isArray(value)) return value.map(withoutDigests)
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const [key, inner] of Object.entries(value)) {
    // 'hash' is the qualification record's spelling for the same thing.
    if (key === 'sha256' || key === 'hash' || key.endsWith('Sha256') || key === 'sourceHashes') continue
    out[key] = withoutDigests(inner)
  }
  return out
}

export function projectShape(projectJson) {
  const { runtimeFiles: _files, ...body } = JSON.parse(projectJson)
  const { runtimeSources: _sources, ...spec } = body.spec
  return withoutDigests({ ...body, spec })
}

/* THE APPARATUS A BASELINE WAS FROZEN AGAINST.
 *
 * Artifact hashes alone cannot tell a stale baseline from a regression: both
 * say "exported bytes moved for: ...". Recording the digest of the modules the
 * export is produced BY lets the gate answer which one it is looking at.
 *
 * This is deliberately EVERY file in src/benchmark/, not RUNTIME_FILES.
 * RUNTIME_FILES is the set a compiled project SHIPS; it does not contain
 * export.mjs, and export.mjs is the module that writes README.md, CITATION.bib,
 * CITATION.cff, package.json and specification.json -- the exact artifacts that
 * moved in the failure this was built for. A discriminator blind to the
 * exporter would have called that stale baseline a regression, which is the
 * same blind spot moved one file to the left. A directory read also needs no
 * hand-maintained list, so a module added tomorrow is covered without anybody
 * remembering to add it.
 *
 * It lives here, beside compiledArtifacts and projectShape, for the reason
 * stated at the top of this file: the gate and the tool that re-freezes it
 * cannot be allowed to disagree about what they are measuring.
 */
export async function apparatusDigests() {
  const directory = new URL('../../../src/benchmark/', import.meta.url)
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile()).sort((a, b) => a.name.localeCompare(b.name))
  return Object.fromEntries(await Promise.all(entries.map(async entry =>
    [entry.name, await sha256(await readFile(new URL(entry.name, directory), 'utf8'))])))
}

// Which of those the current tree disagrees with a recorded set about, named so
// a failure can print them. Covers added and removed files, not only edited.
export function apparatusDrift(recorded, current) {
  const names = [...new Set([...Object.keys(recorded), ...Object.keys(current)])].sort()
  return names.filter(name => recorded[name] !== current[name])
}

const RE_FREEZE = 'Re-freeze with `node tools/research-benchmark-export-baseline.mjs` and say in the commit why.'

/* The explanation printed on a failed test A.
 *
 * `studyMoved` is test B's own question -- did the STUDY CONTENT move, as
 * opposed to only digests -- asked here because it is what separates the two
 * apparatus-edit cases:
 *
 *   apparatus edited, study unchanged -> the baseline is simply older than the
 *     edit. STALE.
 *   apparatus edited, study ALSO moved -> re-freezing would silently record a
 *     different study. A REGRESSION whatever the baseline's age. A rule that
 *     only asked "did any source change" would call this one stale and be
 *     wrong, which is this same blind spot in a new place.
 *   nothing edited -> a compiled output moved on its own. A REGRESSION.
 */
export function whyBytesMoved(moved, recorded, current, studyMoved) {
  const header = `exported bytes moved for: ${moved.join(', ')}`
  if (!recorded) {
    return header + '\n' + 'This baseline records no apparatus digests (its "apparatus" field is absent), so it '
      + `cannot say whether it predates a source edit. ${RE_FREEZE}`
  }
  const drift = apparatusDrift(recorded, current)
  if (drift.length && !studyMoved) {
    return header + '\n' + `The baseline PREDATES these apparatus edits and must be re-frozen: ${drift.join(', ')}. `
      + `The study content is unchanged, so this is a stale baseline and not a regression. ${RE_FREEZE}`
  }
  if (drift.length) {
    return header + '\n' + `These apparatus files changed AND the study content moved with them: ${drift.join(', ')}. `
      + 'That is a REGRESSION, not a stale baseline: re-freezing would record a different study as if it were the old '
      + 'one. Test B names the same problem. Fix the change, or justify the new study, before re-freezing anything.'
  }
  return header + '\n' + 'No apparatus file differs from the ones this baseline was frozen against, so a compiled '
    + 'output moved on its own. That is a REGRESSION, not a stale baseline. Do not re-freeze it away.'
}
