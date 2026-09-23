// IS THE RENDERER THIS HARNESS IS ABOUT TO MEASURE THE ONE THE SOURCE SAYS?
//
// THE DEFECT, MEASURED, TODAY.
//
// A packaged harness stages this tree's dist/ into a copy of the build and
// drives it. On 2026-08-12 a lane fixed a real defect in src/views/computers.js
// at 13:01; dist/index.html had been built at 12:53. The harness staged the
// 12:53 bundle, ran the fix's own acceptance test against a renderer compiled
// EIGHT MINUTES BEFORE THE FIX EXISTED, found the defect still there, and
// reported that the fix did not work.
//
// The wasted run is not the danger. The danger is what a person does next: told
// "your fix does not work" with an apparent measurement behind it, the repair a
// hurried session reaches for is to REVERT A CHANGE THAT WORKS. With several
// lanes editing the renderer at once, mid-edit is the normal condition and not
// the exception, so this is not a rare race.
//
// THE SECOND SHAPE, ALSO MEASURED, AND IT COST THREE RUNS TO FIND.
//
// `vite build` writes a fresh index.html naming a CONTENT-HASHED bundle and
// deletes the previous one. A dist/ copied while another lane is building
// therefore yields an index.html naming a bundle that is not beside it. The
// shell's static server answers an unknown path with index.html and a
// `text/html` content type -- correct SPA behaviour -- and the browser then
// REFUSES the module on the MIME check and runs no script at all. What that
// looks like from a driver is a window with a title, a settings drawer, an
// empty <main id="stage">, and NO EXCEPTION ANYWHERE: the page did not crash,
// it was never given any code. That is indistinguishable from "the page does
// not exist", and it would be reported as the product having no such page.
//
// SO BOTH ARE REFUSALS, NOT VERDICTS, AND THAT DISTINCTION IS THE WHOLE POINT.
//
// A harness that cannot make a sound measurement must say so in its own name
// and stop. It must never emit a sentence about the product, because a sentence
// about the product is what gets a correct change reverted. Every refusal here
// prints under the words HARNESS REFUSAL, names both timestamps or the missing
// file, gives the instruction (`npm run build`), and exits 2.
//
// WHY THIS EXITS THE PROCESS RATHER THAN THROWING.
//
// Twenty-six harnesses in tools/ stage dist/, and their top-level catch blocks
// do not agree with each other: several print a failure line and exit 1, which
// is a verdict about the product -- exactly the sentence that must not be
// produced. Exiting 2 from here is the one way to make the refusal mean the same
// thing in all of them without rewriting twenty-six error paths. It is safe at
// every call site because staging happens before the application is launched,
// so there is no child process to reap and nothing on the glass to tear down.
// Pass `{ onRefusal: 'throw' }` if a caller genuinely needs to handle it, and
// then make sure that caller's handler exits 2.
//
// EXIT 2 IS "THE HARNESS COULD NOT RUN", the code the packaged QA suite already
// uses for that; 1 stays reserved for "an assertion about the product failed".
//
// USED BY every tools/ harness that stages dist/. Extracted rather than copied:
// tools/agent-start-flow-qa.mjs proved the guard, and a guard copied into
// twenty-six files drifts in twenty-six directions.
// tools/test/staged-renderer-guard.test.mjs asserts that every dist-staging
// harness still calls it, so a harness written next week inherits the rule.

import { existsSync, readFileSync, readdirSync, statSync, writeSync } from 'node:fs'
import path from 'node:path'

/* Source files whose change means the bundle is out of date. Anything vite
   compiles or copies into dist/ from src/. */
const SOURCE_EXTENSIONS = /\.(js|mjs|cjs|jsx|ts|tsx|css|json|html|svg)$/

/* An asset reference in the built index.html: `src="/assets/index-a1b2c3.js"`,
   `href="/assets/index-d4e5f6.css"`, and the modulepreload/prefetch forms. */
const ASSET_REFERENCE = /(?:src|href)="(\/assets\/[^"]+)"/g

export class RendererStagingRefusal extends Error {
  constructor(message) {
    super(message)
    this.name = 'RendererStagingRefusal'
    this.harnessRefusal = true
    this.exitCode = 2
  }
}

function refuse(lines, { onRefusal }) {
  const message = ['', 'HARNESS REFUSAL -- this run would not measure what it claims to.', ...lines, ''].join('\n')
  if (onRefusal === 'throw') throw new RendererStagingRefusal(message)
  /* writeSync, not console.error: stderr to a pipe is asynchronous on Windows
     and process.exit can truncate it, which would leave a bare exit 2 with no
     sentence -- the one outcome worse than the stale measurement. */
  writeSync(2, `${message}\n`)
  process.exit(2)
}

/* THE NEWEST THING THE BUNDLE IS BUILT FROM. Walks src/ only: shell/ is copied
   rather than compiled, and node_modules and dotfiles are never inputs vite
   rebuilds for. */
function newestSourceFile(sourceRoot) {
  let newest = { at: 0, file: null }
  const walk = directory => {
    let entries
    try { entries = readdirSync(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!SOURCE_EXTENSIONS.test(entry.name)) continue
      let at
      try { at = statSync(full).mtimeMs } catch { continue }
      if (at > newest.at) newest = { at, file: full }
    }
  }
  walk(sourceRoot)
  return newest
}

/* DOES index.html NAME A BUNDLE THAT IS BESIDE IT? Returns the references it
   could not find, plus the ones that are present but EMPTY -- a zero-byte asset
   is a file caught mid-write, and it produces the same blank stage. */
function inconsistencies(distRoot) {
  const indexPath = path.join(distRoot, 'index.html')
  if (!existsSync(indexPath)) return { noIndex: true, indexReadError: null, missing: [], empty: [], referenced: [] }
  let html
  try { html = readFileSync(indexPath, 'utf8') } catch (error) {
    return { noIndex: false, indexReadError: error, missing: [], empty: [], referenced: [] }
  }
  const referenced = [...html.matchAll(ASSET_REFERENCE)].map(match => match[1])
  const missing = []
  const empty = []
  for (const reference of referenced) {
    const absolute = path.join(distRoot, ...reference.split('/').filter(Boolean))
    if (!existsSync(absolute)) { missing.push(reference); continue }
    try { if (statSync(absolute).size === 0) empty.push(reference) } catch { missing.push(reference) }
  }
  return { noIndex: false, indexReadError: null, missing, empty, referenced }
}

/* The sentence that names the silent symptom, so whoever reads the refusal
   recognises it the next time they see it on the glass instead of here. */
const SILENT_SYMPTOM = [
  '  A renderer copied mid-build names a content-hashed bundle that is not beside it.',
  '  The shell\'s static server then answers that module request with index.html and a',
  '  text/html content type, the browser refuses it on the MIME check, and NO SCRIPT RUNS:',
  '  a window with a title, a settings drawer, an empty stage and no exception anywhere.',
  '  That is indistinguishable from "the page does not exist", so it is refused here',
  '  rather than reported as a defect in the product.',
]

/**
 * Called at the TOP of a harness's stage(), before anything expensive.
 * Refuses when dist/ is older than the newest file in src/, and when the source
 * dist/ is itself torn.
 *
 * @param {object} options
 * @param {string} options.repoRoot     the checkout being measured
 * @param {string} [options.sourceDist] the dist/ that will be staged (honour --dist)
 * @param {string} [options.sourceRoot] defaults to <repoRoot>/src
 * @param {'exit'|'throw'} [options.onRefusal]
 * @returns {{builtAt: string, newestSource: string|null, assets: number}}
 */
export function assertRendererMeasurable({
  repoRoot,
  sourceDist = path.join(repoRoot, 'dist'),
  sourceRoot = path.join(repoRoot, 'src'),
  onRefusal = 'exit',
} = {}) {
  const indexPath = path.join(sourceDist, 'index.html')
  if (!existsSync(indexPath)) {
    refuse([
      `  There is no built renderer at ${indexPath}.`,
      '  Run `npm run build` and try again.',
    ], { onRefusal })
  }

  const built = statSync(indexPath).mtimeMs
  const newest = newestSourceFile(sourceRoot)
  if (newest.file && newest.at > built) {
    refuse([
      '  dist/ is OLDER than the source it is built from, so this run would measure a',
      '  renderer that no longer exists.',
      `    ${path.relative(repoRoot, newest.file)} changed at ${new Date(newest.at).toISOString()}`,
      `    ${path.relative(repoRoot, indexPath)} was built at ${new Date(built).toISOString()}`,
      '  Run `npm run build` and try again.',
      '  A verdict about a stale bundle is worse than no verdict: it contradicts whatever was',
      '  just fixed, and reads like the fix failing -- which gets a correct change reverted.',
    ], { onRefusal })
  }

  const torn = inconsistencies(sourceDist)
  if (torn.indexReadError) {
    refuse([
      `  The built renderer's index.html could not be read at ${indexPath}.`,
      `  ${torn.indexReadError.message}`,
      '  It may have been replaced while dist/ was being built.',
      '  Run `npm run build` and try again.',
    ], { onRefusal })
  }
  if (torn.referenced.length === 0) {
    refuse([
      `  ${path.relative(repoRoot, indexPath)} references no built asset at all, so there is`,
      '  no renderer to measure.',
      '  Run `npm run build` and try again.',
    ], { onRefusal })
  }
  if (torn.missing.length > 0 || torn.empty.length > 0) {
    refuse([
      `  The renderer at ${sourceDist} is INCONSISTENT WITH ITSELF -- it was almost certainly`,
      '  read while another lane was building it.',
      ...(torn.missing.length ? [`    index.html names, and the directory does not hold: ${torn.missing.join(', ')}`] : []),
      ...(torn.empty.length ? [`    named and present but ZERO BYTES (caught mid-write): ${torn.empty.join(', ')}`] : []),
      ...SILENT_SYMPTOM,
      '  Run `npm run build` and try again.',
    ], { onRefusal })
  }

  return {
    builtAt: new Date(built).toISOString(),
    newestSource: newest.file ? path.relative(repoRoot, newest.file) : null,
    assets: torn.referenced.length,
  }
}

/**
 * Called immediately AFTER dist/ has been copied into the staged app, before it
 * is repacked or launched. Catches the copy that was taken while a build was
 * running even though the source was whole a moment earlier.
 *
 * @param {object} options
 * @param {string} options.stagedDist  the dist/ inside the staged app
 * @param {string} [options.sourceDist] named in the message, for orientation
 * @param {'exit'|'throw'} [options.onRefusal]
 * @returns {{assets: number}}
 */
export function assertStagedRendererConsistent({ stagedDist, sourceDist = null, onRefusal = 'exit' } = {}) {
  const torn = inconsistencies(stagedDist)
  if (torn.noIndex) {
    refuse([
      `  The staged renderer has no index.html at ${path.join(stagedDist, 'index.html')}.`,
      '  Nothing was copied, or it was copied while dist/ was being rewritten.',
      '  Run `npm run build` and try again.',
    ], { onRefusal })
  }
  if (torn.indexReadError) {
    refuse([
      `  The staged renderer's index.html could not be read at ${path.join(stagedDist, 'index.html')}.`,
      `  ${torn.indexReadError.message}`,
      '  It may have been replaced while dist/ was being copied.',
      '  Run `npm run build` and try again.',
    ], { onRefusal })
  }
  if (torn.referenced.length === 0) {
    refuse([
      '  The staged renderer\'s index.html references no built asset at all.',
      '  Run `npm run build` and try again.',
    ], { onRefusal })
  }
  if (torn.missing.length > 0 || torn.empty.length > 0) {
    refuse([
      '  The STAGED copy of the renderer is inconsistent: index.html names an asset that did',
      `  not arrive with it${sourceDist ? `, copied from ${sourceDist}` : ''}.`,
      ...(torn.missing.length ? [`    named but not in the copy: ${torn.missing.join(', ')}`] : []),
      ...(torn.empty.length ? [`    named and present but ZERO BYTES (caught mid-write): ${torn.empty.join(', ')}`] : []),
      '  dist/ was almost certainly rebuilt while this harness was copying it.',
      ...SILENT_SYMPTOM,
      '  Run `npm run build` and try again.',
    ], { onRefusal })
  }
  return { assets: torn.referenced.length }
}
