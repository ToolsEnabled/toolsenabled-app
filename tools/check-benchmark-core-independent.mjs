#!/usr/bin/env node
// The seam gate: no core benchmark module may import a symbol from the
// Lean/trading vertical.
//
// This is the check that fails if the inversion regresses. It is deliberately
// crude and static -- it reads the source text rather than the module graph --
// because the property it defends is a source-level one: someone adding a
// benchmark must not have to open a core module, and the cheapest way that
// stops being true is an import line quietly reappearing in one.
//
// Three layers, named explicitly so a reader can tell which is which:
//   core     the compiler. Must not name a vertical module at all.
//   vertical Lean Bench and the trading apparatus. May import core freely.
//   seam     registry.mjs + extraction.mjs (core contracts the vertical fills)
//            and plugins.mjs (the composition root, the ONE place allowed to
//            name the shipped verticals).
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = new URL('../src/benchmark/', import.meta.url)
const VERTICAL = /^(lean|trading)[-.]/
const SEAM = new Set(['plugins.mjs'])

export function layerOf(file) {
  if (SEAM.has(file)) return 'seam'
  if (VERTICAL.test(file) || file === 'lean.mjs') return 'vertical'
  return 'core'
}

// Two independent readings of the same question, because a single grep has
// produced wrong answers in this tree before: (1) static import/export-from
// specifiers, (2) any mention of a vertical module's filename anywhere in the
// text, which also catches dynamic import(), createRequire and string paths.
const SPECIFIER = /(?:^|\n)\s*(?:import|export)[^\n]*?from\s*['"]\.\/([^'"]+)['"]/g
const DYNAMIC = /(?:import|require)\s*\(\s*['"]\.\/([^'"]+)['"]/g

export async function inventory() {
  const files = (await readdir(fileURLToPath(root))).filter(name => name.endsWith('.mjs')).sort()
  const known = new Set(files)
  const rows = []
  for (const file of files) {
    const text = await readFile(new URL(file, root), 'utf8')
    const statics = new Set()
    for (const match of text.matchAll(SPECIFIER)) statics.add(match[1])
    for (const match of text.matchAll(DYNAMIC)) statics.add(match[1])
    // Second method: every known vertical filename mentioned anywhere.
    const mentioned = new Set([...known].filter(name => layerOf(name) === 'vertical' && text.includes(name)))
    rows.push({
      file, layer: layerOf(file),
      importsVertical: [...statics].filter(target => known.has(target) && layerOf(target) === 'vertical').sort(),
      mentionsVertical: [...mentioned].sort()
    })
  }
  return rows
}

// The edges that are KNOWN to remain. A gate that is permanently red is not a
// gate, so this is a ratchet rather than a pass/fail on zero: it fails if a NEW
// coupling appears, and it also fails if an edge here has been removed without
// deleting the line, so the list cannot quietly go stale. Shrink it; never
// extend it to make a build pass.
//
// ZERO IS NOT THE GOAL, AND THIS COUNT IS NOT THE COUPLING. Vertical identifiers
// appear as STRING LITERALS in core code 48 times across 12 core modules --
// 'lean-python', 'lean-bench', 'operational-v1', 'derive-lean',
// 'synchronous-v1'. 'lean-python', the vertical's grading kind, is branched on
// in 9 core modules on its own. Measured with comment lines excluded:
//
//   for f in src/benchmark/*.mjs; do   # skipping lean*/trading*/plugins.mjs
//     grep -vE "^\s*(//|\*|/\*)" "$f" \
//       | grep -oE "'(lean-python|lean-bench|operational-v1|derive-lean|synchronous-v1)'" | wc -l
//   done
//
//   requirements 9  study 8  audit 7  corpus 6  cli 4  qualify 3  tasks 3
//   readiness 2  report 2  requirement-fields 2  runner 1  export 1
//
// So driving the list below to zero would satisfy this gate while the core still
// knows Lean by name in 48 places. That is the same data-not-imports class as
// the four domain allowlists described in plugins.mjs, at eight times the scale,
// and it is a real quality problem -- but it is NOT blocking anyone: a third
// party can register, freeze, export and run today. It is recorded as a sized
// item rather than started. Do not treat a green ratchet as "the core is
// generic"; it means no NEW import coupling was added.
//
// Each entry below says why it is still here, so a reader can tell a deliberate
// edge from an unfinished one.
export const KNOWN_REMAINING = {
  // Native evidence: rebuilds the candidate program and reads the engine's
  // observation profile to verify retained artifacts. Cheap to invert via
  // descriptor capabilities; not yet done.
  'audit.mjs': ['lean-codegen.mjs', 'lean-observations.mjs', 'trading-study.mjs'],
  // The exported runner's verify/grade/recover paths. gradeLean and
  // recoverLeanResources are selected by the 'lean-python' grading kind, which
  // is itself one of the 48 string literals above -- inverting the import
  // without addressing the identifier just moves the coupling.
  'cli.mjs': ['lean-codegen.mjs', 'lean-grade.mjs', 'trading-study.mjs'],
  // RULED: leave it. PROVENANCE is 8 core-machinery entries and 2 Lean ones, so
  // clearing this means SPLITTING the array, which reorders ATTRIBUTIONS.md and
  // provenance.json -- customer-facing documents -- and moves exported bytes for
  // no user benefit. The full reason, including the module-init cycle it would
  // open and the thunk that avoids it, is at the import site in export.mjs.
  'export.mjs': ['lean-codegen.mjs'],
  // Qualification fixtures and the independent interpreters a Lean study is
  // checked against. The fixtures are the vertical's own test material; the
  // descriptor would have to carry them.
  'qualify.mjs': ['lean-cases.mjs', 'lean.mjs', 'trading-market.mjs', 'trading-study.mjs'],
  // Native preparation controls, already gated on domain AND the 'lean-python'
  // grading kind, so the import is the smaller half of this coupling.
  'requirements.mjs': ['lean.mjs', 'trading-market.mjs', 'trading-observations.mjs'],
  // The deepest one: compileOne branches on operationalStudy(spec) and
  // spec.domain === 'lean-bench'. Both branches are GATED, so a third-party
  // study falls through and compiles generically -- which is why this is static
  // linkage of the reference plugin rather than a functional block.
  'tasks.mjs': ['lean.mjs', 'trading-ir.mjs', 'trading-market.mjs', 'trading-observations.mjs', 'trading-study.mjs'],
}

const rows = await inventory()
const actual = Object.fromEntries(rows.filter(row => row.layer === 'core' && row.importsVertical.length)
  .map(row => [row.file, row.importsVertical]))
const mentions = rows.filter(row => row.layer === 'core' && !row.importsVertical.length && row.mentionsVertical.length)

for (const row of rows.filter(r => r.importsVertical.length)) {
  console.log(`${row.layer.padEnd(8)} ${row.file.padEnd(26)} -> ${row.importsVertical.join(', ')}`)
}
const core = rows.filter(r => r.layer === 'core').length
console.log(`
core modules: ${core}  vertical: ${rows.filter(r => r.layer === 'vertical').length}  seam: ${rows.filter(r => r.layer === 'seam').length}`)
console.log(`core modules importing a vertical module: ${Object.keys(actual).length} (known remaining: ${Object.keys(KNOWN_REMAINING).length})`)

if (mentions.length) {
  console.log('\ncore modules that MENTION a vertical filename without importing it (second method):')
  for (const row of mentions) console.log(`  ${row.file} -> ${row.mentionsVertical.join(', ')}`)
}

const problems = []
for (const [file, edges] of Object.entries(actual)) {
  const allowed = KNOWN_REMAINING[file]
  if (!allowed) { problems.push(`NEW coupling: ${file} imports ${edges.join(', ')}. Register through registry.mjs instead; see plugins.mjs.`); continue }
  const added = edges.filter(edge => !allowed.includes(edge))
  if (added.length) problems.push(`NEW coupling: ${file} imports ${added.join(', ')}. Register through registry.mjs instead; see plugins.mjs.`)
}
for (const [file, allowed] of Object.entries(KNOWN_REMAINING)) {
  const edges = actual[file] || []
  const gone = allowed.filter(edge => !edges.includes(edge))
  if (gone.length) problems.push(`STALE entry: ${file} no longer imports ${gone.join(', ')}. Remove it from KNOWN_REMAINING in this file.`)
}

if (problems.length) {
  console.error('\nFAIL:')
  for (const problem of problems) console.error('  ' + problem)
  process.exit(1)
}
console.log(`
OK: no new core->vertical coupling. ${Object.keys(KNOWN_REMAINING).length} module(s) still to invert, exactly as recorded.`)
