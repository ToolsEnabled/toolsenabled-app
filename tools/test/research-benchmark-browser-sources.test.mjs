// The Research page binds a frozen project's runtime from its OWN source map
// (src/research-benchmark-sources.js), which is maintained by hand beside
// RUNTIME_FILES in study.mjs. When the two drift, the page refuses to freeze any
// schema-2 project ("The portable runtime is missing <file>.") while every node
// test of the compiler still passes -- measured on 2026-09-10 when provenance.mjs
// was added to RUNTIME_FILES only. These tests call the page's real map.
import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { readFile } from 'node:fs/promises'
import { RUNTIME_FILES, bindRuntimeSources } from '../../src/benchmark/study.mjs'
import { leanStarter } from '../../src/benchmark/lean.mjs'

register('./raw-loader.mjs', import.meta.url)
const { sources } = await import('../../src/research-benchmark-sources.js')

test('the page can bind the runtime of a frozen project from its own source map', async () => {
  // The exact call the page makes when a person presses Freeze.
  const bound = await bindRuntimeSources(leanStarter(), sources)
  assert.deepEqual(Object.keys(bound.runtimeSources).sort(), [...RUNTIME_FILES].sort())
})

test('every runtime file the page carries is byte-identical to the file it stands for', async () => {
  for (const file of RUNTIME_FILES) {
    assert.equal(typeof sources[file], 'string', `${file}: the Research page does not carry this runtime file`)
    assert.equal(sources[file], await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8'),
      `${file}: the page would pin different bytes than the exported runtime`)
  }
})

test('the page map carries exactly RUNTIME_FILES, no more and no fewer', () => {
  // Compared against the constant itself, never a hand-copied list: a runtime
  // module added to RUNTIME_FILES but not to the page map fails here at once,
  // instead of surfacing only when a person presses Freeze.
  assert.deepEqual(Object.keys(sources).sort(), [...RUNTIME_FILES].sort())
})
