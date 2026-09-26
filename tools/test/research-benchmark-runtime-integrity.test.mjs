// Report item 10 prints whether the runtime the build is running is the runtime the
// frozen project pins. The caller supplies the running digests; the report compares
// them with spec.runtimeSources. Synthetic recorded responses only.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { freezeStudy } from '../../src/benchmark/study.mjs'
import { runStudy } from '../../src/benchmark/runner.mjs'
import { researchReportFiles } from '../../src/benchmark/report.mjs'
import { endpointStudy, FIXED_NOW } from './fixtures/research-benchmark-endpoints.mjs'

const baseline = JSON.parse(await readFile(new URL('./fixtures/research-benchmark-endpoints-baseline.json', import.meta.url), 'utf8'))
// report.mjs escapes markdown punctuation with md(), so the stored text holds an escaped
// copy of the prose; undo exactly that escaping before matching sentences.
const unescapeMd = text => text.replace(/\\([\\`*_{}[\]()#+.!|<>])/g, '$1')

async function reportWith(running) {
  const project = await freezeStudy(endpointStudy(baseline.runtimeSources))
  const result = await runStudy(project, { now: () => FIXED_NOW })
  const options = running === undefined ? {} : { runtimeIntegrity: running(project) }
  const files = await researchReportFiles(project, result.events, options)
  return { project, md: unescapeMd(files['report.md']), html: files['report.html'] }
}

test('no runtime-integrity option prints nothing, because an unchecked runtime is not a matching one', async () => {
  const { md } = await reportWith(undefined)
  assert.doesNotMatch(md, /Runtime integrity:/)
})

test('running digests equal to the pinned ones print the match line with the pinned file count', async () => {
  const { project, md, html } = await reportWith(p => ({ ...p.spec.runtimeSources }))
  const count = Object.keys(project.spec.runtimeSources).length
  assert.ok(count > 1, 'the fixture must pin more than one runtime file')
  assert.match(md, new RegExp("Runtime integrity: the running build's runtime matches the frozen project's pinned runtime \\(" + count + " files\\)\\."))
  assert.doesNotMatch(md, /differs from the frozen project/)
  // The HTML rendering carries the same sentence, so the page and the CLI report agree.
  assert.ok(html.includes('Runtime integrity: the running build&#39;s runtime matches the frozen project&#39;s pinned runtime (' + count + ' files).'),
    'the HTML report must carry the same runtime-integrity sentence')
})

test('a differing digest names the file with its frozen and its running digest', async () => {
  const { project, md } = await reportWith(p => ({ ...p.spec.runtimeSources, 'report.mjs': 'f'.repeat(64) }))
  const frozen = project.spec.runtimeSources['report.mjs']
  assert.match(md, /Runtime integrity: the running build's runtime differs from the frozen project's pinned runtime in 1 file: /)
  assert.match(md, new RegExp('report\\.mjs ' + frozen + ' -> ' + 'f'.repeat(64)))
  assert.match(md, /The digests printed above are the frozen project's; the exported CLI reproduces this report with the pinned bytes\./)
  assert.doesNotMatch(md, /runtime matches the frozen project/)
})

test('a runtime file the running build does not carry is named absent, never as agreeing', async () => {
  const { md } = await reportWith(p => { const copy = { ...p.spec.runtimeSources }; delete copy['report.mjs']; return copy })
  assert.match(md, /report\.mjs [0-9a-f]{64} -> absent/)
  assert.match(md, /differs from the frozen project's pinned runtime in 1 file/)
})
