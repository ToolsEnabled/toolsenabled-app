import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { compilePrompt, canonical } from '../../src/benchmark/prompts.mjs'
import { compileTask, semanticTaskId } from '../../src/benchmark/tasks.mjs'
import { renderComposition, compositionProjectFiles } from '../../src/benchmark/composition.mjs'
import { genericStarter } from '../../src/benchmark/starters.mjs'
import { newVarianceStudy, varianceInventory, varianceMark, buildVarianceStudy, saveVarianceLibrary, materializeVarianceTasks } from '../../src/research-variance.mjs'
import { expandComposition } from '../../src/research-routing.mjs'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { projectFiles } from '../../src/benchmark/export.mjs'
import { developmentStarter } from './fixtures/research-benchmark-development.mjs'

function fixture() {
  const spec = genericStarter()
  spec.catalog = [
    { id: 'leaf', version: '1', kind: 'atom', role: 'node', text: 'Buy slowly. Sell tomorrow. 😀', semantics: { kind: 'instruction', preserve: true } },
    { id: 'pair', version: '1', kind: 'template', role: 'node', text: 'First: {{slot:a}}\nSecond: {{slot:b}}\nRepeat: {{slot:a}}', slots: { a: 'node', b: 'node' }, semantics: { kind: 'sequence' } },
  ]
  spec.tasks = [{ id: 'base', root: { use: 'pair', slots: { a: { use: 'leaf' }, b: { use: 'leaf' } } }, expected: 'reference', input: { case: 1 }, split: 'development' }]
  const routing = { version: 1, fields: [], rules: [], rows: [], otherwise: null, compositions: [{ name: 'Pair', node: spec.tasks[0].root }] }
  return { spec, routing }
}
async function plan(spec, routing, source, target = 'root#1', text = 'Sell tomorrow.') {
  const inventory = await varianceInventory(spec, routing, source)
  const entry = inventory.entries.find(item => item.key === target), start = entry.text.indexOf(text)
  const study = { ...newVarianceStudy('study-1'), name: 'Missing exit', source }
  study.marks.push(varianceMark(inventory, target, start, start + text.length, { label: 'Exit instruction' }))
  return study
}

test('one appearance and every identical use are distinct, while overlapping omissions form a union', async () => {
  const { spec, routing } = fixture(), original = canonical(spec)
  const study = await plan(spec, routing, { kind: 'task', id: 'base' }, 'root/a#1')
  let built = await buildVarianceStudy(spec, routing, study)
  assert.equal(built.previews[1].compiled.text.match(/Sell tomorrow/g).length, 2)
  assert.deepEqual(built.tasks[1].input, spec.tasks[0].input)
  assert.equal(built.tasks[1].expected, 'reference')
  study.marks[0].scope = 'matching'
  built = await buildVarianceStudy(spec, routing, study)
  assert.equal(built.previews[1].compiled.text.includes('Sell tomorrow'), false)
  assert.deepEqual(built.previews[0].compiled.semantic, built.previews[1].compiled.semantic)
  study.mode = 'together'; study.marks.push({ ...study.marks[0], id: 'section-2', label: 'Overlapping selection' })
  built = await buildVarianceStudy(spec, routing, study)
  assert.equal(built.previews[1].removed, 'Sell tomorrow.'.length * 3)
  assert.equal(canonical(spec), original)
})

test('a variant snippet can replace one member, repeat inside compositions, and sit in deeper nests', async () => {
  const { spec, routing } = fixture()
  const study = await plan(spec, routing, { kind: 'snippet', id: 'leaf' })
  const saved = await saveVarianceLibrary(spec, routing, study), id = saved.saved[0].id
  const mixed = { use: 'pair', slots: { a: { use: id }, b: { use: 'leaf' } } }
  const compiled = await compilePrompt(saved.catalog, mixed)
  assert.equal(compiled.text.match(/Sell tomorrow/g).length, 1, 'only the original member keeps the sentence')
  assert.equal(compiled.sourceMap.filter(row => row.path === 'root/a' && row.omittedCharacters > 0).length, 2)
  assert.equal(compiled.checklist.find(row => row.path === 'root/a').disclosure, 'partial')
  const deep = await compilePrompt(saved.catalog, { use: 'pair', slots: { a: mixed, b: { use: 'leaf' } } })
  assert.equal(deep.text.match(/Sell tomorrow/g).length, 3)
  assert.deepEqual(renderComposition(JSON.parse(canonical(deep.composition))).text, deep.text)
  const task = await compileTask({ ...spec, catalog: saved.catalog }, { ...spec.tasks[0], root: mixed })
  const files = compositionProjectFiles({ tasks: [task] })
  assert.equal(files['prompts/base.txt'], compiled.text + '\n')
})

test('a full composition variance is reusable while its original members remain unchanged', async () => {
  const { spec, routing } = fixture()
  const study = await plan(spec, routing, { kind: 'composition', id: 'Pair' }, 'root/b#1', 'Buy slowly.')
  const saved = await saveVarianceLibrary(spec, routing, study)
  assert.equal(saved.draft.compositions.at(-1).node.composition, 'Pair', 'the variant retains its reusable named source')
  const root = expandComposition(saved.saved[0].id, saved.draft, { catalog: saved.catalog })
  const parent = await compilePrompt(saved.catalog, { use: 'pair', slots: { a: root, b: spec.tasks[0].root } })
  assert.equal(parent.text.match(/Buy slowly/g).length, 7, 'two uses of the variant each omit one occurrence, while the original keeps all three')
  assert.equal(saved.catalog[0].text, spec.catalog[0].text)
  assert.ok(parent.sourceMap.every(row => row.start >= 0 && row.end >= row.start && row.end <= parent.text.length))
})

test('omitting a whole snippet produces an empty contribution without dropping its semantics', async () => {
  const { spec, routing } = fixture(), source = { kind: 'snippet', id: 'leaf' }
  const inventory = await varianceInventory(spec, routing, source)
  const study = { ...newVarianceStudy('whole'), name: 'Whole omission', source, marks: [varianceMark(inventory, 'root#1', 0, inventory.compiled.text.length)] }
  const saved = await saveVarianceLibrary(spec, routing, study)
  const compiled = await compilePrompt(saved.catalog, { use: saved.saved[0].id })
  assert.equal(compiled.text, '')
  assert.equal(compiled.semantic.preserve, true)
  assert.equal(compiled.checklist[0].disclosed, false)
})

test('changed sources cannot silently apply stale selections or reusable omissions', async () => {
  const { spec, routing } = fixture(), study = await plan(spec, routing, { kind: 'task', id: 'base' }, 'root/a#1')
  spec.catalog[0].text = 'Changed. ' + spec.catalog[0].text
  await assert.rejects(buildVarianceStudy(spec, routing, study), /earlier prompt/)
  const next = fixture(), saved = await saveVarianceLibrary(next.spec, next.routing, await plan(next.spec, next.routing, { kind: 'snippet', id: 'leaf' }))
  saved.catalog.at(-1).text += ' Changed.'
  await assert.rejects(compilePrompt(saved.catalog, { use: saved.saved[0].id }), /source.*changed/)
})

test('a saved task-level variant retains its variable values when reused without the source task', async () => {
  const spec = genericStarter(); spec.tasks[0].variables = { instruction: 'Use this exact context.' }
  const study = await plan(spec, null, { kind: 'task', id: spec.tasks[0].id }, 'root#1', 'exact ')
  const saved = await saveVarianceLibrary(spec, null, study)
  const compiled = await compilePrompt(saved.catalog, expandComposition(saved.saved[0].id, saved.draft))
  assert.match(compiled.text, /Use this context/)
  assert.doesNotMatch(compiled.text, /Answer the task precisely/)
})

test('omission tasks export, verify and run with the pinned standalone runtime', async t => {
  const spec = developmentStarter()
  const study = await plan(spec, null, { kind: 'task', id: 'addition-a' }, 'root/task#1', 'only ')
  const composition = await saveVarianceLibrary(spec, null, study)
  const snippet = await saveVarianceLibrary(spec, null, await plan(spec, null, { kind: 'snippet', id: 'task' }, 'root#1', 'only '))
  const additional = [
    { ...spec.tasks[0], id: 'reusable-composition', root: { use: 'context', slots: { task: expandComposition(composition.saved[0].id, composition.draft) } } },
    { ...spec.tasks[0], id: 'reusable-snippet', root: { use: 'context', params: { instruction: 'Run this reusable snippet variant.' }, slots: { task: { use: snippet.saved[0].id } } } },
  ]
  spec.tasks = [...(await buildVarianceStudy(spec, null, study)).tasks, ...additional]; spec.catalog = snippet.catalog
  spec.conditions[0].adapter.responses = Object.fromEntries(spec.tasks.map(task => [task.id, '5']))
  const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8')])))
  const frozen = await freezeStudy(await bindRuntimeSources(spec, sources)), files = await projectFiles(frozen, sources)
  const root = await mkdtemp(resolve(tmpdir(), 'variance-runtime-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const [file, text] of Object.entries(files)) { await mkdir(dirname(resolve(root, file)), { recursive: true }); await writeFile(resolve(root, file), text) }
  for (const command of ['verify', 'run']) {
    const result = spawnSync(process.execPath, [resolve(root, 'cli.mjs'), command, '--project', root], { encoding: 'utf8', timeout: 60000, windowsHide: true })
    assert.equal(result.status, 0, result.stderr || result.error?.message)
  }
  const events = (await readFile(resolve(root, 'results/attempts.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(events.filter(event => event.status === 'completed').length, 4)
  assert.equal(frozen.tasks[1].compiled.text.includes('only'), false)
})

test('generation reuses an existing control and records separate omission arms without duplicate tasks', async () => {
  const { spec, routing } = fixture(), study = await plan(spec, routing, { kind: 'task', id: 'base' }, 'root/a#1')
  const result = await materializeVarianceTasks(spec, routing, study)
  assert.equal(result.tasks.length, 2); assert.equal(result.added.length, 1); assert.deepEqual(result.reused, ['base'])
  assert.equal(result.tasks[0].factors[result.factor], 'Original · no omissions')
  assert.equal(spec.tasks[0].factors, undefined, 'the source specification is not mutated')
  const base = await compileTask({ ...spec, protocol: { ...spec.protocol, grading: { kind: 'json' } } }, result.tasks[0])
  const variant = await compileTask({ ...spec, protocol: { ...spec.protocol, grading: { kind: 'json' } } }, result.tasks[1])
  assert.notEqual(await semanticTaskId('lean-bench', base), await semanticTaskId('lean-bench', variant), 'declared omissions remain distinct even when their private semantics are identical')
  const again = await materializeVarianceTasks({ ...spec, tasks: result.tasks }, routing, study)
  assert.equal(again.tasks.length, 2); assert.equal(again.added.length, 0); assert.equal(again.reused.length, 2)
})
