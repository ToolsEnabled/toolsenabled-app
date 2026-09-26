// Venue report item 10: the integrity section summarises the export manifest it
// was given, and the exported CLI and the page stand-in give it the same one.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { approveBundle, sha256 } from '../../src/benchmark/prompts.mjs'
import { leanStarter } from '../../src/benchmark/lean.mjs'
import { bindLeanReview } from '../../src/benchmark/lean-codegen.mjs'
import { genericStarter, newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { runStudy } from '../../src/benchmark/runner.mjs'
import { researchReportFiles } from '../../src/benchmark/report.mjs'
import { projectFiles } from '../../src/benchmark/export.mjs'
import { runProject } from '../../src/benchmark/cli.mjs'
import { pageReportOptions } from './fixtures/research-page-report-options.mjs'

const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8')])))
const REVIEWER = 'REPORT MANIFEST FIXTURE MARKER ONLY'
const unescapeMarkdown = text => text.replace(/\\([\\`*_{}\[\]()#+.!|<>])/g, '$1')
const unescapeHtml = text => text.replace(/&(amp|lt|gt|quot|#39);/g, match => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[match])
const both = files => [unescapeMarkdown(files['report.md']), unescapeHtml(files['report.html'])]
const integrity = text => text.slice(text.indexOf('Integrity and reproduction'), text.indexOf('Limitations and threats to validity'))
const approve = spec => Promise.all(spec.catalog.map(bundle => approveBundle(bundle, REVIEWER, '2026-09-10T00:00:00.000Z', { catalog: spec.catalog })))

async function leanCanary() {
  let spec = newExperimentDraft(leanStarter(), { purpose: 'recorded-diagnostic' })
  spec = await bindLeanReview(await bindRuntimeSources(spec, sources), sources)
  spec.catalog = await approve(spec)
  return freezeStudy(spec)
}
async function generic() {
  let spec = newExperimentDraft(genericStarter(), { purpose: 'recorded-diagnostic' })
  spec = await bindRuntimeSources(spec, sources); spec.catalog = await approve(spec)
  return freezeStudy(spec)
}

test('item 10: the integrity section summarises the supplied export manifest and retains it verbatim', async () => {
  const project = await leanCanary(), events = (await runStudy(project)).events
  const manifest = (await projectFiles(project, sources))['manifest.json'], parsed = JSON.parse(manifest)
  const files = await researchReportFiles(project, events, { manifest })
  const runtime = Object.keys(project.spec.runtimeSources).length
  for (const text of both(files)) {
    const section = integrity(text)
    assert.ok(section.includes(await sha256(manifest)), 'the manifest digest is shown')
    assert.ok(section.includes('Files bound') && section.includes(String(Object.keys(parsed.files).length)), 'the bound file count is shown')
    assert.ok(section.includes(runtime + ' of ' + runtime), 'every runtime digest agrees with the frozen project')
    assert.ok(section.includes('paper/manifest.json'), 'the complete manifest is linked')
  }
  assert.equal(files['paper/manifest.json'], manifest, 'the manifest is retained byte for byte')
  assert.ok(JSON.parse(files['execution-manifest.json']).files.includes('paper/manifest.json'))
})

test('item 10: a manifest that disagrees with the frozen project is named, and one for another project is refused', async () => {
  const project = await leanCanary(), events = (await runStudy(project)).events
  const parsed = JSON.parse((await projectFiles(project, sources))['manifest.json']), runtime = Object.keys(project.spec.runtimeSources).length
  const changed = structuredClone(parsed); changed.files['report.mjs'] = 'd'.repeat(64)
  for (const text of both(await researchReportFiles(project, events, { manifest: JSON.stringify(changed) }))) {
    const section = integrity(text)
    assert.ok(section.includes((runtime - 1) + ' of ' + runtime), 'the disagreeing runtime digest is counted')
    assert.match(section, /disagrees with the frozen project: report\.mjs/)
  }
  const other = structuredClone(parsed); other.projectSha256 = 'e'.repeat(64)
  const refused = await researchReportFiles(project, events, { manifest: JSON.stringify(other) })
  for (const text of both(refused)) assert.match(integrity(text), /belongs to project e{64}, not to this frozen project/)
  assert.equal(refused['paper/manifest.json'], undefined, 'nothing from a refused manifest is retained')
  for (const text of both(await researchReportFiles(project, events))) assert.match(integrity(text), /No export manifest was supplied with this rendering/)
  await assert.rejects(researchReportFiles(project, events, { manifest: 42 }), /manifest must be supplied as text/)
})

test('item 10: the exported CLI renders the manifest beside the project exactly as the page stand-in computes it', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'report-manifest-cli-')); t.after(() => rm(root, { recursive: true, force: true }))
  const project = await generic(), exported = await projectFiles(project, sources, {})
  for (const [file, text] of Object.entries(exported)) { await mkdir(dirname(resolve(root, file)), { recursive: true }); await writeFile(resolve(root, file), text) }
  const result = await runProject(root)
  const analysis = spawnSync(process.execPath, [resolve(root, 'cli.mjs'), 'analyze'], { encoding: 'utf8', timeout: 30000, windowsHide: true })
  assert.equal(analysis.status, 0, analysis.stderr)
  const expected = await researchReportFiles(project, result.events, await pageReportOptions({ project, sources }))
  assert.ok(expected['report.md'].includes(await sha256(exported['manifest.json'])), 'the stand-in renders the manifest the page would export')
  for (const file of ['report.html', 'report.md', 'paper/manifest.json', 'execution-manifest.json'])
    assert.equal(await readFile(resolve(root, 'results', file), 'utf8'), expected[file], file)
})
