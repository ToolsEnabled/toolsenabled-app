// Venue report item 6: qualification receipts are linked from the journal, or the
// report says exactly why none is shown, and native container arguments are read
// from the grade records this run produced rather than from fixed text.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { approveBundle, sha256 } from '../../src/benchmark/prompts.mjs'
import { leanStarter } from '../../src/benchmark/lean.mjs'
import { bindLeanReview } from '../../src/benchmark/lean-codegen.mjs'
import { newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { runStudy } from '../../src/benchmark/runner.mjs'
import { researchReportFiles } from '../../src/benchmark/report.mjs'
import { projectFiles } from '../../src/benchmark/export.mjs'
import { runProject } from '../../src/benchmark/cli.mjs'
import * as leanObservations from '../../src/benchmark/lean-observations.mjs'
import { genericActivationFixture } from './fixtures/research-benchmark-generic-activation.mjs'

const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8')])))
const REVIEWER = 'REPORT PROTOCOL APPARATUS FIXTURE MARKER ONLY'
const IMAGE = 'quantconnect/lean@sha256:' + 'a'.repeat(64)
const unescapeMarkdown = text => text.replace(/\\([\\`*_{}\[\]()#+.!|<>])/g, '$1')
const unescapeHtml = text => text.replace(/&(amp|lt|gt|quot|#39);/g, match => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[match])
const both = files => [unescapeMarkdown(files['report.md']), unescapeHtml(files['report.html'])]
const protocolSection = text => text.slice(text.indexOf('Method: protocol and apparatus'), text.indexOf('Run walkthrough'))

async function leanCanary({ native = false } = {}) {
  let spec = newExperimentDraft(leanStarter(), { purpose: native ? 'apparatus-development' : 'recorded-diagnostic' })
  if (native) {
    spec.environment.leanImage = IMAGE; spec.protocol.grading = { kind: 'lean-python', executionTimeoutMs: 30000 }
    spec.conditions[0].adapter.responses = { 'flat-canary': '# PROTOCOL APPARATUS MARKER PROGRAM; NEVER EXECUTED\n' }
  }
  spec = await bindLeanReview(await bindRuntimeSources(spec, sources), sources)
  spec.catalog = await Promise.all(spec.catalog.map(bundle => approveBundle(bundle, REVIEWER, '2026-09-10T00:00:00.000Z', { catalog: spec.catalog })))
  return freezeStudy(spec)
}
const nativeGrade = extra => ({ passed: true, score: 1, classification: 'correct', directory: 'artifacts/marker', image: IMAGE, candidateSha256: 'b'.repeat(64),
  execution: { exitCode: 0, signal: null, stdout: '', stderr: '' }, ...extra })

test('item 6: without a journaled qualification the report states exactly why no receipt is shown', async () => {
  const project = await leanCanary()
  assert.equal(project.requirements?.selectedInput, undefined, 'the Lean Bench starter freezes no selected-input policy')
  const files = await researchReportFiles(project, (await runStudy(project)).events)
  for (const text of both(files)) {
    const section = protocolSection(text)
    assert.match(section, /freezes no selected-input qualification policy \(requirements\.selectedInput is absent\)/)
    assert.match(section, /results\/qualification\.json, outside the attempt journal/)
    assert.match(section, /neither reads nor verifies that file/)
  }
})

test('item 6: journaled qualification receipts are listed in the protocol section with links to their retained reports', async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'report-protocol-qualification-')); t.after(() => rm(directory, { recursive: true, force: true }))
  const fixture = await genericActivationFixture()
  fixture.spec.inputs = await Promise.all(Object.entries(fixture.attachments).map(async ([path, bytes]) => ({ path, sha256: await sha256(bytes) })))
  const project = await freezeStudy(await bindRuntimeSources(fixture.spec, sources))
  for (const [file, bytes] of Object.entries(await projectFiles(project, sources, fixture.attachments))) { await mkdir(dirname(resolve(directory, file)), { recursive: true }); await writeFile(resolve(directory, file), bytes) }
  const result = await runProject(directory), receipts = result.events.filter(event => event.type === 'qualification')
  assert.ok(receipts.length >= 1, 'the run journals its qualification receipt')
  const files = await researchReportFiles(project, result.events)
  for (const text of both(files)) {
    const section = protocolSection(text)
    assert.match(section, /1 qualification receipt recorded in the attempt journal before collection/)
    for (const event of receipts) {
      const href = 'qualification-receipts/' + event.seq + '/qualification/report.html'
      assert.ok(section.includes(href), 'the protocol section links ' + href)
      assert.ok(Object.hasOwn(files, href), 'the linked receipt report is retained in the package')
    }
  }
})

test('item 6: container arguments are read from the native grade records of this run, and absent ones are named', async () => {
  const project = await leanCanary({ native: true })
  const container = { engine: 'docker', arguments: ['run', '--marker-recorded-flag', 'value', '--mount', 'type=bind,source=<data>,target=/MarkerData,readonly', IMAGE] }
  const recorded = await researchReportFiles(project, (await runStudy(project, { grade: async () => nativeGrade({ container }) })).events)
  for (const text of both(recorded)) {
    const section = protocolSection(text)
    assert.ok(section.includes('docker run --marker-recorded-flag value'), 'the recorded arguments are shown')
    assert.match(section, /recorded in 1 of 1 native grade records/)
    assert.ok(section.includes('/MarkerData (read-only)'), 'mounts come from the recorded arguments')
    assert.ok(!section.includes('--cap-drop ALL'), 'no fixed flag text is printed beside the record')
  }
  const legacy = await researchReportFiles(project, (await runStudy(project, { grade: async () => nativeGrade() })).events)
  for (const text of both(legacy)) {
    const section = protocolSection(text)
    assert.match(section, /Not recorded: none of the 1 native grade records in this journal carries its container arguments/)
    assert.ok(!section.includes('--cap-drop ALL'), 'an absent record is not filled with fixed text')
  }
})

test('item 6: the LEAN grader records the arguments it runs, with placeholders for host paths', async () => {
  assert.equal(typeof leanObservations.leanContainerArguments, 'function', 'lean-observations.mjs builds the container arguments')
  assert.equal(typeof leanObservations.leanContainerRecord, 'function', 'lean-observations.mjs builds the recorded form')
  const projectSha256 = 'c'.repeat(64)
  // The arguments lean-grade.mjs passed to docker before this change, with sample host values.
  const host = { name: 'research-lean-00000000-0000-0000-0000-000000000000', algorithm: '/host/a', data: '/host/d', results: '/host/r', config: '/host/c/config.json' }
  const before = ['run', '--pull', 'never', '--rm', '--name', host.name, '--label', `research-benchmark.project=${projectSha256}`, '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '512', '--memory', '2g', '--cpus', '2', '--read-only', '--tmpfs', '/tmp:rw,size=256m', '-e', 'PYTHONDONTWRITEBYTECODE=1',
    '--mount', `type=bind,source=${host.algorithm},target=/Algorithm,readonly`, '--mount', `type=bind,source=${host.data},target=/Data,readonly`,
    '--mount', `type=bind,source=${host.results},target=/Results`, '--mount', `type=bind,source=${host.config},target=/Config/config.json,readonly`, IMAGE, '--config', '/Config/config.json']
  assert.deepEqual(leanObservations.leanContainerArguments({ projectSha256, image: IMAGE, ...host }), before, 'the executed arguments are unchanged')
  const record = leanObservations.leanContainerRecord({ projectSha256, image: IMAGE })
  assert.equal(record.engine, 'docker')
  assert.deepEqual(record.arguments, leanObservations.leanContainerArguments({ projectSha256, image: IMAGE }))
  for (const value of Object.values(host)) assert.ok(!record.arguments.some(arg => arg.includes(value)), 'no host value is recorded: ' + value)
  const grader = sources['lean-grade.mjs']
  assert.match(grader, /leanContainerArguments\(\{ projectSha256: project\.sha256, image, name, algorithm, data, results, config: join\(directory, 'config\.json'\) \}\)/, 'the grader executes the shared argument builder')
  assert.match(grader, /container: leanContainerRecord\(\{ projectSha256: project\.sha256, image \}\)/, 'the grader records the same builder output')
})
