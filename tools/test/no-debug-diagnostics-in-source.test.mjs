/* DEBUG INSTRUMENTATION MUST NOT REACH A BUILD, AND NOTHING WAS WATCHING.
 *
 * MEASURED 2026-08-20. A lane driving a data-loss defect left two lines in the
 * shared checkout:
 *
 *   src/views/computers.js:912   (window.__mcOrderDriveCapture ||= []).push({...}) // TEMP order-drive diagnostic
 *   src/views/computers.js:3441  (window.__mcOrderDriveRestore ||= []).push({...}) // TEMP order-drive diagnostic
 *
 * Both were honestly marked. Nothing read the marker. `tools/strip-build-
 * diagnostics.mjs` sounds like it would catch this and does not -- it deletes
 * electron-builder's `builder-debug.yml` sidecar out of the release directory
 * and never looks at source. So the only thing standing between an unbounded
 * array growing on `window` in a shipped product and a customer was somebody
 * happening to read a diff.
 *
 * Six lanes were editing this checkout that night. A convention nobody enforces
 * is a convention exactly until the busiest hour, which is the hour it matters.
 *
 * WHAT THIS REFUSES, and why each pattern rather than a general "looks like
 * debugging" heuristic -- a heuristic would either miss the real thing or go
 * red on honest code, and a guard people switch off is worse than none:
 *
 *   1. A `TEMP` marker in a comment. It is this repo's own word for "remove me",
 *      so the author has already told us; we just have to listen.
 *   2. A double-underscore `window.__x` global. The product's real bridges are
 *      single-underscore-free and named (`window.mcAgent`, `window.mcSettings`,
 *      `window.mcAccount`), so `__` is unambiguously the debug convention here.
 *   3. `TODO REMOVE` / `XXX` in the shipped directories.
 *
 * Drivers and tests under tools/ are DELIBERATELY not scanned: instrumentation
 * belongs there. That is the whole point -- the fix for a lane that wants a
 * capture array is to evaluate it into the page from its driver, not to leave
 * it in src/.
 *
 * Run: node --test tools/test/no-debug-diagnostics-in-source.test.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createHash } from 'node:crypto'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SHIPPED_DIRECTORIES = ['src', 'shell', 'public']

/* DECLARED PROBE SEAMS, and why an allowlist rather than dropping the rule.
 *
 * The first version of this guard flagged six lines that turned out to be
 * deliberate, documented probe hooks the packaged drivers depend on:
 * metrics-charts.js and metrics-live-charts.js each say in so many words
 * "Probe hook, NOT app state... nothing in the app reads this", tree-graph.js
 * publishes its frame counters from `_publishProbe()`, and components.js's
 * chatDebug is gated behind `import.meta.env?.DEV` so it does not exist in a
 * production bundle at all.
 *
 * Deleting the rule would have been the easy answer and the wrong one: the risk
 * is a NEW, undeclared global appearing in a hurry, which is exactly what
 * happened. So the declared ones are named here. Adding a name to this list is
 * a deliberate act with a reader attached; leaving one out is what gets caught.
 */
const DECLARED_PROBE_GLOBALS = Object.freeze([
  '__chatDebug',      // components.js, DEV-only, absent from production bundles
  '__mcCharts',       // metrics-charts.js, documented probe hook, removed by dispose()
  '__mcLiveCharts',   // metrics-live-charts.js, same seam, same reason
  '__graphFrameMs', '__pageFrameMs', '__graphTickMs', '__graphNodeCount', '__graphStress', // tree-graph.js _publishProbe()
  /* views/computers.js. NOT a leftover: a named DOM contract in the page 2
     implementation, and four drivers read it today -- tools/page2-qa.cjs,
     tools/node-remove-drive.mjs,
     tools/chat-history-drive.mjs, tools/home-activity-substance-qa.mjs. It is
     also cleared on teardown (clearMountedGraph). Removing it would go red in
     four suites, so it is declared here rather than deleted. */
  '__mcGraph',
  /* public/preview/main.js, read by tools/preview-browser-drive.mjs. That
     file says in its own header why it is read-only on purpose: the driver
     mutates the page from outside, so this seam exposes no setter. */
  '__preview',
])

const declaredGlobal = line => DECLARED_PROBE_GLOBALS.some(name => line.includes(`window.${name}`))

const PATTERNS = Object.freeze([
  { name: 'TEMP marker', re: /(?:\/\/|\/\*|\*)\s*TEMP\b/ },
  { name: 'undeclared debug window global', re: /\bwindow\.__[A-Za-z]/, unless: declaredGlobal },
  { name: 'TODO REMOVE', re: /\bTODO[ :]*REMOVE\b/i },
  { name: 'XXX marker', re: /(?:\/\/|\/\*|\*)\s*XXX\b/ },
])

// Byte-identical MediaPipe 1.0.1 WASM glue, also verified by the asset provisioner.
// These two upstream comments concern audio URL cleanup and canvas lookup, not
// application debug instrumentation. Do not edit vendor bytes to hide them or
// skip the vendor directory. Only these comments in this exact pinned file are
// classified; ANY changed byte is a failure, even one that matches no pattern.
const UPSTREAM_FILE = 'public/hand-controls/vendor/vision_wasm_internal.js'
const UPSTREAM_SHA256 = 'e170ee67dd4e16c1a6fcd8840a206687e5a59b22c20e4a902bc445b095454d73'
const UPSTREAM_COMMENTS = new Set([
  '// XXX we never revoke this!',
  "// TODO: Remove this line, target '#canvas' should refer only to Module['canvas'], not to GL.offscreenCanvases['canvas'] - but need stricter tests to be able to remove this line.",
])

function sourceOffences(file, source) {
  const hits = []
  const pinned = file === UPSTREAM_FILE && createHash('sha256').update(source).digest('hex') === UPSTREAM_SHA256
  if (file === UPSTREAM_FILE && !pinned) {
    hits.push({ file, line: 1, pattern: 'upstream bytes changed', text: 'The reviewed third-party source no longer matches its pin.' })
  }
  source.split('\n').forEach((line, index) => {
    for (const pattern of PATTERNS) {
      if (!pattern.re.test(line)) continue
      if (pattern.unless && pattern.unless(line)) continue
      if (pinned && UPSTREAM_COMMENTS.has(line.trim())) continue
      hits.push({ file, line: index + 1, pattern: pattern.name, text: line.trim().slice(0, 120) })
    }
  })
  return hits
}

function sourceFiles() {
  const found = []
  const walk = directory => {
    if (!fs.existsSync(directory)) return
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue
        walk(full)
        continue
      }
      if (/\.(js|cjs|mjs)$/.test(entry.name)) found.push(full)
    }
  }
  for (const directory of SHIPPED_DIRECTORIES) walk(path.join(repoRoot, directory))
  return found
}

function offences(files) {
  const hits = []
  for (const file of files) {
    hits.push(...sourceOffences(path.relative(repoRoot, file).replace(/\\/g, '/'), fs.readFileSync(file, 'utf8')))
  }
  return hits
}

const files = sourceFiles()

test('the scan actually looks at the shipped source', () => {
  /* Guard the instrument before trusting it. A green that scanned zero files
     is the failure this whole suite exists to prevent, one level up. */
  assert.ok(files.length > 40,
    `only ${files.length} source files found; the walk has stopped seeing the product and this guard is asserting nothing`)
})

test('no debug instrumentation is left in shipped source', () => {
  const hits = offences(files)
  assert.deepEqual(hits, [],
    `debug instrumentation would ship -- nothing in the release chain removes it, so it must not be committed:\n${
      hits.map(h => `  ${h.file}:${h.line}  [${h.pattern}]  ${h.text}`).join('\n')}`)
})

test('the guard detects each pattern it claims to detect', () => {
  /* POSITIVE CONTROL. Every pattern is proved able to fire, on strings held
     here rather than by writing a decoy file into the shared checkout -- six
     lanes were working in it and a planted file is somebody else's red. */
  const samples = [
    ['TEMP marker', '  ;(window.x ||= []).push(1) // TEMP order-drive diagnostic'],
    ['undeclared debug window global', '  ;(window.__mcOrderDriveCapture ||= []).push({ at: 1 })'],
    ['TODO REMOVE', '  const x = 1 // TODO REMOVE before shipping'],
    ['XXX marker', '  // XXX this is a hack'],
  ]
  for (const [name, line] of samples) {
    const pattern = PATTERNS.find(entry => entry.name === name)
    assert.ok(pattern.re.test(line), `the ${name} pattern no longer matches its own example`)
  }
  /* And it must NOT fire on the product's real bridges, or the guard becomes a
     thing people delete rather than a thing they obey. */
  for (const honest of [
    '  const account = window.mcAccount && window.mcAccount.current',
    '  read: () => ipcRenderer.invoke(\'mc-settings:read\'),',
    '  // the temperature of the model is not a TEMPfile',
  ]) {
    for (const pattern of PATTERNS) {
      assert.ok(!pattern.re.test(honest),
        `the ${pattern.name} pattern fires on honest code: ${honest.trim()}`)
    }
  }
})

test('upstream comment classification cannot hide modified vendor bytes or application diagnostics', () => {
  const source = fs.readFileSync(path.join(repoRoot, UPSTREAM_FILE), 'utf8')
  assert.deepEqual(sourceOffences(UPSTREAM_FILE, source), [])
  assert.equal(source.split('\n').filter(line => UPSTREAM_COMMENTS.has(line.trim())).length, 2)
  assert.ok(sourceOffences(UPSTREAM_FILE, source + '\n').some(hit => hit.pattern === 'upstream bytes changed'))
  assert.ok(sourceOffences(UPSTREAM_FILE, source + '\nwindow.__capture = []').some(hit => hit.pattern === 'undeclared debug window global'))
  for (const file of ['src/example.js', 'public/hand-controls/vendor/another.js']) {
    assert.equal(sourceOffences(file, [...UPSTREAM_COMMENTS].join('\n')).length, 2)
  }
})
