#!/usr/bin/env node

// THE APP AND ITS PACKED ENGINE MUST AGREE ON EVERY SETTINGS ROW THE APP DRAWS.
//
// Measured 2026-09-16 on the 1.0.45 cut 1 (app da0f2fde, engine bf3bde09): the
// Settings page's working-profile presets and the "Who adds standing rules"
// quick slider both read the row `rules.filing_from`, which the engine landed
// on a branch the cut never carried. The packed capability registry had no such
// row, so the Working profile slider disabled itself with "This host cannot
// apply the profile field ..." and the rules slider read "Not available in this
// build". The owner saw "my slider doesn't even work". The app's own suite
// (tools/test/product-setting-rows.test.mjs) was red against the packed payload
// -- but the cut's suites had run against a different capability/ copy than the
// one it packed, so nothing refused the pair.
//
// This gate reads the rows the renderer references from the three modules that
// own them, and the rows the PACKED registry declares, and refuses the tree when
// any referenced row is missing. It runs after pack:capability in `npm run
// dist`, at the front of `npm test`, and as a structural promotion gate, so an
// app/engine pair that disagrees cannot be cut, tested green, or promoted.
//
// It parses the source files as text on purpose: the renderer modules pull in
// DOM-facing helpers, and a gate that needs a DOM stand-in to run is a gate that
// can fail for reasons that have nothing to do with the question it asks.
//
// Exit 0: every referenced row is declared.  Exit 1: rows are missing (named).
// Exit 3: nothing could be measured (no packed payload, a source module could
// not be read, or a source module named no rows) -- which is not a pass.

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REGISTRY = path.join(ROOT, 'capability', 'config', 'settings-registry.json')
const ROW = /^[a-z]+\.[a-z_]+$/

/* Each source module and the exact constant whose quoted keys are settings row
   ids. Anything quoted elsewhere in the file (a sentence that happens to
   contain a dotted word) is outside the constant and never counted. */
const SOURCES = Object.freeze([
  { file: 'src/research-settings.js', constant: 'PRODUCT_SETTING_IDS', why: 'the rows the full Settings page draws' },
  { file: 'src/settings-profile-policy.js', constant: 'PROFILE_PRODUCT_VALUES', why: 'the rows every working preset sets' },
  { file: 'src/settings-profile-policy.js', constant: 'PROFILE_PRODUCT_PRESERVED', why: 'the rows a working preset explicitly leaves alone' },
  { file: 'src/settings-quick-sliders.js', constant: 'QUICK_SLIDERS', why: 'the rows the quick sliders set' },
])

function constantBody(text, constant, file) {
  const start = text.indexOf(`export const ${constant} =`)
  if (start < 0) throw new Error(`${file} no longer exports ${constant}; point this gate at the constant that owns those rows`)
  // The constant ends at the first line that is exactly "])" or "})" after it.
  const rest = text.slice(start)
  const end = rest.search(/\n[\]}]\)?\s*\n/)
  return end < 0 ? rest : rest.slice(0, end)
}

export function referencedRows(root = ROOT) {
  const rows = new Map()
  for (const source of SOURCES) {
    const file = path.join(root, source.file)
    const text = readFileSync(file, 'utf8')
    const body = constantBody(text, source.constant, source.file)
    // Both quote styles: research-settings.js writes its ids in double quotes.
    const found = [...body.matchAll(/['"]([a-z]+\.[a-z_]+)['"]/g)].map(match => match[1]).filter(id => ROW.test(id))
    if (!found.length) throw new Error(`${source.file} ${source.constant} named no settings rows; the gate cannot measure it`)
    for (const id of found) if (!rows.has(id)) rows.set(id, source.why)
  }
  return rows
}

export function declaredRows(registryFile = REGISTRY) {
  if (!existsSync(registryFile)) throw new Error(`no packed registry at ${registryFile}; run pack:capability first`)
  const registry = JSON.parse(readFileSync(registryFile, 'utf8'))
  const ids = new Set()
  const walk = value => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { value.forEach(walk); return }
    if (typeof value.id === 'string' && ROW.test(value.id)) ids.add(value.id)
    for (const child of Object.values(value)) walk(child)
  }
  walk(registry)
  if (!ids.size) throw new Error(`${registryFile} declares no settings rows; the gate cannot measure it`)
  return ids
}

export function verdict({ root = ROOT, registryFile = REGISTRY } = {}) {
  const referenced = referencedRows(root)
  const declared = declaredRows(registryFile)
  const missing = [...referenced].filter(([id]) => !declared.has(id)).map(([id, why]) => ({ id, why }))
  return { referenced: referenced.size, declared: declared.size, missing }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let result
  try { result = verdict() }
  catch (error) {
    console.error(`check-settings-rows-declared: NOT MEASURED -- ${error.message}`)
    process.exit(3)
  }
  if (result.missing.length) {
    console.error(`MISSING -- ${result.missing.length} of ${result.referenced} settings rows the app draws are not declared by the packed engine registry (${result.declared} rows):`)
    for (const row of result.missing) console.error(`  - ${row.id}  (${row.why})`)
    console.error('Land the engine change that declares them, or take the row out of the app, before cutting or promoting this pair.')
    process.exit(1)
  }
  console.log(`DECLARED -- all ${result.referenced} settings rows the app draws are declared by the packed engine registry (${result.declared} rows).`)
}
