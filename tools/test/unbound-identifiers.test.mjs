/* NO RENDERER MODULE MAY REFERENCE A NAME IT NEVER BOUND.
 *
 * This is the gate for the defect in tools/check-unbound-identifiers.mjs's own
 * header: `isWriteEnabled` used and not imported in
 * src/setup-profile-settings.js, shipped unminified in the renderer bundle of
 * every build that carried the permission-level row, throwing on every press
 * AFTER it had written the person's new permission level to disk.
 *
 * THE CHECKER IS CHECKED FIRST, and that order is the point. A guard that
 * reports nothing passes a clean tree and a broken one identically, and this
 * repo has already been bitten by a gate that went green because it measured
 * nothing (see tools/check-suites-discovered.mjs). So the first two tests plant
 * the defect and require it to be found; only then does the third one trust a
 * quiet answer about src/.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { controlBytes, scanControlBytes, scanRendererSource, unboundIdentifiers } from '../check-unbound-identifiers.mjs'

/* The byte under test is built by number. Spelling it as an escape in this
   file would hand the write path that eats escapes a chance to plant the very
   defect this suite guards against, inside the guard. */
const byte = (code) => String.fromCharCode(code)

test('the checker finds the exact defect that shipped', () => {
  /* src/setup-profile-settings.js, reduced to the shape that shipped: the
     module imports its neighbour and uses one more name from it than it asked
     for. */
  const shipped = `
    import { WRITE_ACTION_FLAGS, setWriteEnabled } from './write-flags.js'
    export function chooseTier() {
      const wasOn = new Map(WRITE_ACTION_FLAGS.map(flag => [flag.id, isWriteEnabled(flag.id)]))
      setWriteEnabled('dispatch', false)
      return wasOn
    }
  `
  assert.deepEqual(unboundIdentifiers(shipped), ['isWriteEnabled'])
})

test('the checker accepts every way this codebase legitimately binds a name', () => {
  const clean = `
    import defaultThing, { named as renamed } from './x.js'
    import * as everything from './y.js'
    const { a, b: [c], ...rest } = defaultThing
    let d
    var e = 1
    function f(g, { h } = {}, ...i) { return g + h + i + d + e }
    class K extends everything.Base {
      static field = 1
      method(arg) { return arg + renamed }
    }
    const arrow = (m = c) => m + a + rest
    try { arrow() } catch (problem) { console.log(problem, f, K) }
    for (const item of [a]) { console.log(item) }
    label: for (let index = 0; index < 1; index += 1) { break label }
    const key = 'z'
    const read = defaultThing[key] + defaultThing.key
    export { read }
  `
  assert.deepEqual(unboundIdentifiers(clean), [],
    'a legal binding form is being reported as undefined, which would make this gate unusable')
})

test('a property, a label and a meta property are not references to anything', () => {
  const shapes = `
    const target = { notAGlobalName: 1, nested: { alsoNot: 2 } }
    const url = import.meta.url
    const reached = target.notAGlobalName + target.nested.alsoNot
    outer: while (reached) { break outer }
    export { url, reached }
  `
  assert.deepEqual(unboundIdentifiers(shapes), [])
})

test('no renderer module references a name it never bound', () => {
  const { scanned, findings } = scanRendererSource()
  assert.ok(scanned > 50, `only ${scanned} renderer modules were scanned; the scan is not reaching src/`)
  assert.deepEqual(
    findings.map(finding => `${finding.file}: ${finding.name}`),
    [],
    'each of these throws the moment its line runs, in the shipped product',
  )
})

/* ---- control bytes (T350) ----
   Same order as above: plant the defect and require it to be found, then
   trust a quiet answer about the tree. */

test('the byte scan finds an eaten escape and reports where it is', () => {
  /* The exact shape that shipped at the 1.0.45 assembly tip: /queued\b/i with
     the two characters backslash-b replaced by one backspace. */
  const eaten = 'const stuck = !/queued' + byte(8) + '/i.test(word)'
  assert.deepEqual(controlBytes(eaten), [{ offset: 22, byte: 8 }])
  /* And the separator shape: a NUL and a 0x01 where escapes were meant. */
  const separators = 'a' + byte(0) + 'b' + byte(1) + 'c'
  assert.deepEqual(controlBytes(separators), [{ offset: 1, byte: 0 }, { offset: 3, byte: 1 }])
  assert.deepEqual(controlBytes('x' + byte(0x7f)), [{ offset: 1, byte: 0x7f }], 'DEL is a control byte too')
})

test('the byte scan leaves tab, line feed, carriage return and the escape TEXT alone', () => {
  const legitimate = 'const r = /queued\\b/i\r\n\tconst s = "\\x01\\0\\u0000"\n'
  assert.deepEqual(controlBytes(legitimate), [],
    'an escape written as text is the correct form and must not be reported')
  assert.deepEqual(controlBytes(Buffer.from('café — ok', 'utf8')), [],
    'multi-byte UTF-8 has no byte below 0x20 and must not be reported')
})

test('the tree scan reaches tools/ and tools/test/, names the file and the byte offset, and honours the allowlist', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'control-bytes-'))
  try {
    for (const dir of ['src', 'tools', 'tools/test', 'tools/node_modules/dep']) mkdirSync(path.join(root, dir), { recursive: true })
    writeFileSync(path.join(root, 'src/clean.js'), 'export const a = /queued\\b/i\n')
    writeFileSync(path.join(root, 'tools/driver.mjs'), 'const r = /queued' + byte(8) + '/i\n')
    writeFileSync(path.join(root, 'tools/test/guard.test.mjs'), 'assert(!/' + byte(8) + 'h\\s*=/.test(s))\n')
    writeFileSync(path.join(root, 'tools/test/fixture.json'), '{"k":"' + byte(1) + '"}\n')
    writeFileSync(path.join(root, 'tools/notes.md'), 'markdown may hold ' + byte(8) + '\n')
    writeFileSync(path.join(root, 'tools/node_modules/dep/index.js'), 'dependency ' + byte(0) + '\n')
    const { scanned, findings } = scanControlBytes(root)
    assert.equal(scanned, 4, 'four source files by extension; markdown and node_modules are not in scope')
    assert.deepEqual(findings, [
      { file: 'tools/driver.mjs', offset: 17, byte: 8 },
      { file: 'tools/test/fixture.json', offset: 6, byte: 1 },
      { file: 'tools/test/guard.test.mjs', offset: 9, byte: 8 },
    ])
    const allowed = scanControlBytes(root, { allowlist: new Map([['tools/test/fixture.json', 'a fixture that carries the byte on purpose']]) })
    assert.deepEqual(allowed.findings.map(finding => finding.file), ['tools/driver.mjs', 'tools/test/guard.test.mjs'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('no source file under src/, tools/ or tools/test/ carries a control byte', () => {
  const { scanned, findings } = scanControlBytes()
  assert.ok(scanned > 500, `only ${scanned} files were scanned; the scan is not reaching tools/test/`)
  assert.deepEqual(
    findings.map(finding => `${finding.file}: byte ${finding.byte} at offset ${finding.offset}`),
    [],
    'each of these is an escape that was eaten on the way to disk; write it as the escape it was meant to be',
  )
})
