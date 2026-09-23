import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const GATE = path.join(REPO_ROOT, 'tools/check-unbound-identifiers.mjs')

function fixture(t, sources) {
  const root = mkdtempSync(path.join(tmpdir(), 'check-unbound-identifiers-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(path.join(root, 'tools'))
  mkdirSync(path.join(root, 'src'))
  cpSync(GATE, path.join(root, 'tools/check-unbound-identifiers.mjs'))
  symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(root, 'node_modules'), 'junction')
  for (const [name, source] of Object.entries(sources)) {
    const destination = path.join(root, 'src', name)
    mkdirSync(path.dirname(destination), { recursive: true })
    writeFileSync(destination, source)
  }
  return root
}

function runGate(root, { copied = false } = {}) {
  const gate = path.join(root, 'tools/check-unbound-identifiers.mjs')
  let invoked = gate
  if (copied) {
    invoked = path.join(root, 'tools/check-unbound-identifiers-renamed.mjs')
    cpSync(gate, invoked)
  }
  return spawnSync(process.execPath, [invoked], { cwd: root, encoding: 'utf8' })
}

test('check-unbound-identifiers.mjs runs through a differently named copy and refuses an unbound identifier', t => {
  const root = fixture(t, { 'broken.js': 'export const broken = neverDeclared\n' })
  const result = runGate(root, { copied: true })

  assert.equal(result.signal, null)
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /src\/broken\.js: "neverDeclared" is used and never bound in this file\./)
})

test('check-unbound-identifiers.mjs refuses an empty source enumeration', t => {
  const result = runGate(fixture(t, {}))

  assert.equal(result.signal, null)
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /scanned 0 files, so this proved nothing\./)
})

test('check-unbound-identifiers.mjs still passes after inspecting healthy source', t => {
  const result = runGate(fixture(t, { 'healthy.js': 'export const answer = 42\n' }))

  assert.equal(result.signal, null)
  assert.equal(result.status, 0)
  assert.equal(result.stderr, '')
  assert.match(result.stdout, /1 renderer modules, no unbound identifiers\./)
})

/* `arguments` is bound by every non-arrow function, including a method
   shorthand in an object literal -- the shape src/research-assignments.js uses
   in `async unassign(...) { if (arguments.length > 3) ... }`. The gate reported
   it unbound, which is not a real defect but did hold the whole release chain
   red: `dist` runs `verify:release`, which is `test-ratchet.mjs --strict`, and
   a strict ratchet refuses to measure at all rather than record a baseline. */
test('check-unbound-identifiers.mjs knows a method shorthand binds arguments', t => {
  const result = runGate(fixture(t, {
    'shorthand.js': 'export const api = {\n'
      + '  unassign(a, b, c, d = null) {\n'
      + '    return arguments.length > 3 ? d : c\n'
      + '  },\n'
      + '}\n'
  }))

  assert.equal(result.signal, null)
  assert.equal(result.status, 0)
  assert.equal(result.stderr, '')
  assert.match(result.stdout, /1 renderer modules, no unbound identifiers\./)
})

/* And the fix must not become a blanket allow. An arrow function does NOT bind
   `arguments`; it inherits it, so at module top level there is nothing to
   inherit and the reference genuinely throws. This is the case that proves the
   change above added a real rule rather than silencing the name. */
test('check-unbound-identifiers.mjs still refuses arguments inside a top-level arrow', t => {
  const result = runGate(fixture(t, {
    'arrow.js': 'export const count = () => arguments.length\n'
  }))

  assert.equal(result.signal, null)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /src\/arrow\.js: "arguments" is used and never bound in this file\./)
})
