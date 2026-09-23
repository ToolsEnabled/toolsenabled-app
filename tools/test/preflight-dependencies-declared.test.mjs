/* Every package the `npm test` preflight chain imports must be DECLARED.
 *
 * `npm test` is an &&-chain: a handful of `node tools/check-*.mjs` gates run
 * before a single test does. If one of those gates cannot even load, nothing
 * after it runs, and the checkout reports neither pass nor fail.
 *
 * That happened. tools/check-unbound-identifiers.mjs imports `rollup/parseAst`,
 * and `rollup` was declared nowhere in package.json. It resolved anyway on
 * machines that had run `npm ci`, because npm HOISTS vite's transitive copy of
 * rollup to top-level node_modules -- package-lock.json shows vite as the only
 * package requiring it (`node_modules/vite -> ^4.34.9`). Hoisting is a layout
 * npm happens to produce, not a contract it promises: it changes with the
 * dependency graph, and an installer using an isolated layout does not produce
 * it at all. The gate was one `npm ci` away from failing for reasons no one
 * would have connected to a missing declaration.
 *
 * So this asserts the invariant directly: if a preflight gate imports it, the
 * project declares it.
 *
 * DERIVED, NOT HAND-LISTED. The chain is parsed out of package.json's own
 * `scripts.test`, and each gate's local import closure is walked, so adding a
 * gate or a new import to one is covered without editing this file. A
 * hand-maintained list of gates would drift from the script the day someone
 * edits it, and drift silently.
 *
 * This suite reads only package.json, package-lock.json and source text, so it
 * runs on a checkout with no node_modules at all -- which is exactly the
 * checkout where the missing declaration bites.
 *
 * SCOPE, stated because it is narrower than it could be: this covers the
 * preflight chain, not every file under tools/. Other undeclared imports exist
 * in the test tree (@electron/asar, ajv, app-builder-lib, builder-util-runtime,
 * tar -- all electron-builder transitives). They are the same class of defect
 * but they block individual suites rather than the whole chain, and confirming
 * the right declaration for each needs an electron-builder install this
 * checkout does not have. Widening this suite to cover them without doing that
 * work would mean adding a tolerance list, which is worse than the gap.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const BUILTINS = new Set(builtinModules)

/* `import x from 'y'`, `import 'y'`, `export * from 'y'`, and `require('y')`. */
const SPECIFIER = /(?:import\s[^;]*?from\s*|import\s*|export\s[^;]*?from\s*)["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)/g

/** The gates `npm test` runs before any test, read out of the script itself. */
function preflightGates() {
  const script = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).scripts?.test
  assert.ok(typeof script === 'string' && script.length > 0, 'package.json must declare a "test" script')
  const gates = []
  for (const step of script.split('&&').map((value) => value.trim())) {
    // Stop at the first step that is not a direct `node tools/...` gate: past
    // that point the chain is running the suites, not the preflight.
    const match = /^node\s+(tools\/[\w.-]+\.(?:mjs|cjs|js))$/.exec(step)
    if (!match) break
    gates.push(match[1])
  }
  return gates
}

/** Resolve a relative specifier the way Node would, for local files only. */
function resolveLocal(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier)
  const candidates = [base, `${base}.mjs`, `${base}.js`, `${base}.cjs`,
    path.join(base, 'index.mjs'), path.join(base, 'index.js'), path.join(base, 'index.cjs')]
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

/** Every bare package specifier reachable from `roots` through local imports. */
function packageClosure(roots) {
  const visited = new Set()
  const packages = new Map()
  const queue = roots.map((relative) => path.join(REPO_ROOT, relative))

  while (queue.length) {
    const file = queue.pop()
    if (visited.has(file) || !existsSync(file)) continue
    visited.add(file)
    const source = readFileSync(file, 'utf8')
    SPECIFIER.lastIndex = 0
    let match
    while ((match = SPECIFIER.exec(source))) {
      const specifier = match[1] || match[2]
      if (!specifier || specifier.startsWith('node:') || BUILTINS.has(specifier)) continue
      if (specifier.startsWith('.') || specifier.startsWith('/')) {
        const local = resolveLocal(file, specifier)
        if (local) queue.push(local)
        continue
      }
      // '@scope/name/sub' -> '@scope/name';  'rollup/parseAst' -> 'rollup'
      const name = specifier.startsWith('@')
        ? specifier.split('/').slice(0, 2).join('/')
        : specifier.split('/')[0]
      if (BUILTINS.has(name)) continue
      if (!packages.has(name)) packages.set(name, new Set())
      packages.get(name).add(path.relative(REPO_ROOT, file))
    }
  }
  return { packages, visited }
}

test('the npm test preflight chain is a non-empty list of gates that exist', () => {
  const gates = preflightGates()
  // Absence-as-emptiness guard: a chain that parsed to nothing would make every
  // assertion below vacuously true and this suite would pass having checked nothing.
  assert.ok(gates.length > 0, 'no preflight gates were parsed out of package.json scripts.test')
  for (const gate of gates) {
    assert.ok(existsSync(path.join(REPO_ROOT, gate)), `scripts.test runs ${gate}, which does not exist`)
  }
})

test('every package the preflight chain imports is declared in package.json', () => {
  const gates = preflightGates()
  const { packages, visited } = packageClosure(gates)
  assert.ok(visited.size >= gates.length, 'the closure walk did not reach the gates themselves')

  const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))
  const declared = new Set([
    ...Object.keys(manifest.dependencies || {}),
    ...Object.keys(manifest.devDependencies || {}),
  ])

  const undeclared = [...packages].filter(([name]) => !declared.has(name)).sort()
  assert.deepEqual(undeclared.map(([name]) => name), [],
    'these packages are imported by the npm test preflight chain but declared in neither ' +
    'dependencies nor devDependencies, so the chain only runs where npm happens to hoist them:\n' +
    undeclared.map(([name, files]) => `  ${name} <- ${[...files].sort().join(', ')}`).join('\n'))
})

test('a declared preflight package resolves to the version the lockfile already pins', () => {
  const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))
  const lockPath = path.join(REPO_ROOT, 'package-lock.json')
  if (!existsSync(lockPath)) return
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  const root = lock.packages?.['']
  assert.ok(root, 'package-lock.json must carry a root package entry')

  /* npm ci refuses to run when package.json and the lockfile disagree, so a
   * declaration added to one and not the other trades a missing dependency for
   * a broken install. */
  for (const field of ['dependencies', 'devDependencies']) {
    for (const [name, range] of Object.entries(manifest[field] || {})) {
      assert.equal(root[field]?.[name], range,
        `package.json ${field}.${name} is "${range}" but package-lock.json root has ` +
        `"${root[field]?.[name]}" -- npm ci would refuse this checkout`)
    }
  }

  const { packages } = packageClosure(preflightGates())
  for (const name of packages.keys()) {
    const entry = lock.packages?.[`node_modules/${name}`]
    assert.ok(entry, `${name} is imported by the preflight chain but package-lock.json pins no version for it`)
  }
})
