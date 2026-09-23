/* EVERY MODULE THE SHELL LOADS OUT OF THE PAYLOAD MUST BE NAMED IN THE MANIFEST.
 *
 * MEASURED 2026-08-19 against the staged payload and shell/agent-host.cjs.
 * The host names eight payload modules in PAYLOAD_*_MODULE constants. Four of
 * them appeared in no list in tools/capability-manifest.json:
 *
 *   src/lib/agent-tool-summary.js          ABSENT from capability/ entirely
 *   src/lib/r-ledger.js                    shipped only because agent-onboarding.js requires it
 *   src/lib/agent-comms/tree-node-directory.js
 *   src/lib/providers/agent-comms-local.js shipped only because tool-registry.js requires it
 *
 * So three of the four rode into the payload on somebody else's require graph,
 * and the fourth did not ride at all: the tool note -- the thing that tells an
 * agent what this product can do -- was dead in the shipped bytes while the
 * engine suite that proves its behaviour was green.
 *
 * WHY NOTHING CAUGHT IT, AND WHY THE ANSWER HAS TO BE A BUILD-TIME GATE.
 * The host loads these modules deliberately fail-soft; its own comment states
 * the rule: "A payload cut before the module existed injects nothing and starts
 * sessions exactly as it always has... A missing introduction must not become a
 * dead product." That is the right runtime behaviour and it is not what is being
 * changed here. But it means a missing module produces no throw, no log and no
 * degraded start -- the product simply, silently, does less. Runtime is designed
 * to stay quiet, so build time is the only place the absence can be seen.
 *
 * The closure walk cannot see these either. It follows require() from the
 * payload's own entrypoints, and these modules are required by the SHELL, which
 * lives in the app repo and is not walked. A module with no engine-side
 * requirer is therefore invisible to every existing guard: the walk does not
 * reach it, check-payload-current only compares files that are already staged,
 * and the boundary guard classifies what is present rather than asking what is
 * missing. This test asks the one question none of them ask.
 *
 * Run: node --test tools/test/shell-payload-modules-declared.test.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const shellDir = path.join(repoRoot, 'shell')
const manifestPath = path.join(repoRoot, 'tools', 'capability-manifest.json')

/* The lists that put a JavaScript module into the payload. hostModules is the
   intended home for anything the shell require()s, but a module reached as an
   entrypoint or as a dynamic-require root ships just as surely, so membership in
   any of them satisfies the guarantee this test exists to hold. The reported
   list name is kept so a mis-filed entry is still legible to a reader. */
const SHIPPING_LISTS = Object.freeze(['entrypoints', 'hostModules', 'dynamicRequires'])

const CONSTANT = /const\s+PAYLOAD_[A-Z0-9_]*MODULE\s*=\s*(['"])([^'"]+)\1/g

function shellPayloadModules(sources) {
  const found = new Map()
  for (const [file, text] of sources) {
    for (const match of text.matchAll(CONSTANT)) {
      const declared = match[2]
      if (!found.has(declared)) found.set(declared, file)
    }
  }
  return found
}

/* The whole judgement, as one pure function, so the positive control below can
   run it against a manifest that is not the one on disk. */
function undeclaredPayloadModules(sources, manifest) {
  const shipping = new Map()
  for (const list of SHIPPING_LISTS) {
    for (const entry of manifest[list] || []) if (!shipping.has(entry)) shipping.set(entry, list)
  }
  const undeclared = []
  for (const [declared, file] of shellPayloadModules(sources)) {
    if (!shipping.has(declared)) undeclared.push({ module: declared, declaredIn: file })
  }
  return undeclared
}

/* THE SECOND WAY THE SHELL LOADS A PAYLOAD MODULE, WHICH THE CONSTANT ABOVE
   CANNOT SEE.
 *
 * MEASURED 2026-09-07 against shell/ at the selected app ref. The constant form
 * the guard above scans for is not the only one in use: the shell also composes
 * the path segment by segment at the call site --
 *
 *   requireModule(path.join(engineRoot, 'src', 'lib', 'multi-account', 'handover.js'))
 *
 * -- and no PAYLOAD_*_MODULE constant is ever written for it. There is no
 * literal 'src/lib/...' string anywhere in the file, so CONSTANT matches
 * nothing and the module is invisible to the judgement above. Eight capability
 * modules loaded this way were undeclared in every manifest list when this was
 * measured, including src/lib/accessibility.js, src/lib/role-functions.js and
 * src/lib/app-context.js -- the three the accessibility and voice feature runs
 * through. All eight were nevertheless PRESENT in the staged payload, because
 * something else in the closure happened to require them. That is precisely the
 * fragility the guard above exists to end: shipping by luck rather than by
 * declaration, with a fail-soft loader that turns a future omission into a
 * product that silently does less rather than an error anyone sees.
 *
 * A segment that is not a string literal cannot be resolved by reading the
 * source, so those are collected separately and asserted against a known list
 * rather than skipped. A silent skip here would be the same defect in the
 * instrument that the test is about in the product. */
const COMPOSED = /(?:require|requireModule)\(\s*path\.join\(([^)]*)\)/g

const SEGMENT = /^(['"])([^'"]*)\1$/

/* Returns what the shell composes, split into what can be read off the source
   and what cannot. Only chains whose first literal segment is 'src' are payload
   modules; path.join(root, 'tools', ...) addresses the checkout, not the
   capability layer. */
function composedPayloadRequires(sources) {
  const resolved = new Map()
  const unresolved = []
  for (const [file, text] of sources) {
    for (const match of text.matchAll(COMPOSED)) {
      const args = match[1].split(',').map(part => part.trim()).filter(Boolean)
      const segments = args.slice(1)
      if (segments.length === 0) continue
      const first = SEGMENT.exec(segments[0])
      if (!first || first[2] !== 'src') continue
      const literals = []
      let readable = true
      for (const segment of segments) {
        const literal = SEGMENT.exec(segment)
        if (!literal) { readable = false; break }
        literals.push(literal[2])
      }
      if (!readable) {
        unresolved.push({ expression: match[0].trim(), composedIn: file })
        continue
      }
      const module = literals.join('/')
      if (!resolved.has(module)) resolved.set(module, file)
    }
  }
  return { resolved, unresolved }
}

/* The same judgement as undeclaredPayloadModules, over the composed form, as a
   pure function of a manifest so the positive control can run it against one
   that is not on disk. */
function undeclaredComposedModules(sources, manifest) {
  const shipping = new Set()
  for (const list of SHIPPING_LISTS) for (const entry of manifest[list] || []) shipping.add(entry)
  const undeclared = []
  for (const [module, file] of composedPayloadRequires(sources).resolved) {
    if (!shipping.has(module)) undeclared.push({ module, composedIn: file })
  }
  return undeclared
}

function readShellSources() {
  return fs.readdirSync(shellDir)
    .filter(name => name.endsWith('.cjs') || name.endsWith('.js'))
    .map(name => [path.join('shell', name), fs.readFileSync(path.join(shellDir, name), 'utf8')])
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const sources = readShellSources()

test('the shell names payload modules this test can actually find', () => {
  /* Guard the instrument before trusting it. If the constants are ever renamed
     or the host stops using a literal, this test would pass by finding nothing
     -- a green that means "I looked at zero modules". */
  const found = shellPayloadModules(sources)
  assert.ok(found.size >= 8,
    `only ${found.size} PAYLOAD_*_MODULE constants found; the pattern has stopped matching and this suite is no longer looking at anything`)
})

test('every payload module the shell loads is named in the manifest', () => {
  const undeclared = undeclaredPayloadModules(sources, manifest)
  assert.deepEqual(undeclared, [],
    `the shell require()s these out of the payload but no manifest list names them, so whether they ship depends on another module happening to require them:\n${
      undeclared.map(u => `  ${u.module}  (declared in ${u.declaredIn})`).join('\n')}`)
})

test('the guard reports each shell payload module when its shipping declaration is removed', () => {
  // Inject one missing declaration into an in-memory manifest at a time. The
  // historical hostModules list made new, correctly declared modules look like
  // regressions. This proves every current constant is guarded, including new
  // modules, while the unchanged real-manifest test above still requires all
  // of them to ship.
  const found = shellPayloadModules(sources)
  // Keep the historical regression anchors independent of the scanner: a
  // scanner that silently drops one must not shrink its own fault controls.
  for (const module of [
    'src/lib/agent-comms/tree-node-directory.js',
    'src/lib/agent-engine/local-node-process.js',
    'src/lib/agent-ledger-continuation.js',
    'src/lib/agent-tool-summary.js',
    'src/lib/capability-recall/index.js',
    'src/lib/ledger-category-reset.js',
    'src/lib/owner-capture-spool.js',
    'src/lib/owner-request-store.js',
    'src/lib/providers/agent-comms-local.js',
    'src/lib/r-ledger-agent-gate.js',
    'src/lib/r-ledger-proposals.js',
    'src/lib/r-ledger.js',
    'src/lib/rules-turn-snapshot.js',
  ]) assert.ok(found.has(module), `the shell module regression anchor ${module} disappeared from the scan`)
  for (const [module, declaredIn] of found) {
    const missingOne = { ...manifest }
    for (const list of SHIPPING_LISTS) {
      missingOne[list] = (manifest[list] || []).filter(entry => entry !== module)
    }
    assert.deepEqual(undeclaredPayloadModules(sources, missingOne), [{ module, declaredIn }],
      `removing ${module} from every shipping list must report that exact missing module`)
  }
})

test('the composed-require scan is actually finding composed requires', () => {
  /* Guard the second instrument before trusting it, for the same reason as the
     first: if the shell stops spelling these as path.join at the call site, or
     the argument list wraps in a way this scan cannot read, the judgement below
     would pass by looking at nothing. Seventeen resolvable composed payload
     requires were measured on 2026-09-07; the floor is deliberately below that
     so ordinary refactoring does not fail this, while a scan that has stopped
     matching does. */
  const { resolved } = composedPayloadRequires(sources)
  assert.ok(resolved.size >= 15,
    `only ${resolved.size} composed payload requires found; the scan has stopped matching and this check is no longer looking at anything`)
})

test('every payload module the shell composes with path.join is named in the manifest', () => {
  const undeclared = undeclaredComposedModules(sources, manifest)
  assert.deepEqual(undeclared, [],
    `the shell require()s these out of the payload by composing the path at the call site, but no manifest list names them, so whether they ship depends on another module happening to require them:\n${
      undeclared.map(u => `  ${u.module}  (composed in ${u.composedIn})`).join('\n')}`)
})

test('the composed-require guard reports an absence when there is one', () => {
  /* POSITIVE CONTROL. A check that has never failed proves nothing, and the
     shared checkout must never be broken to demonstrate a red. So the same
     judgement runs against a manifest that declares nothing, leaving the real
     one on disk untouched, and must report the modules the shell composes. */
  const declaresNothing = { ...manifest, entrypoints: [], hostModules: [], dynamicRequires: [] }
  const reported = new Set(undeclaredComposedModules(sources, declaresNothing).map(entry => entry.module))
  assert.ok(reported.size > 0, 'the judgement reported no undeclared module against a manifest that declares none')
  assert.ok(reported.has('src/lib/multi-account/handover.js'),
    'the account-handover module the shell composes is not reported as undeclared even when the manifest declares nothing')
  assert.ok(reported.has('src/lib/accessibility.js'),
    'the accessibility host module the shell composes is not reported as undeclared even when the manifest declares nothing')
})

test('a composed require this test cannot read is named, never silently skipped', () => {
  /* A segment that is a variable cannot be resolved by reading the source, so
     it can be neither declared nor checked here. The one measured case walks a
     caller-supplied leaf. Naming it means a NEW unreadable one fails this test
     and forces a decision, instead of disappearing into a green run. */
  const { unresolved } = composedPayloadRequires(sources)
  const files = [...new Set(unresolved.map(entry => entry.composedIn))].sort()
  assert.deepEqual(files, [path.join('shell', 'agent-confinement-read.cjs')],
    `a payload require is composed from a value this test cannot read, so nothing can declare or check it:\n${
      unresolved.map(u => `  ${u.expression}  (composed in ${u.composedIn})`).join('\n')}`)
})
