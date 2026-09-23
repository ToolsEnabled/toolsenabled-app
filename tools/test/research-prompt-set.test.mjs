import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { materializeCorpus, bindRuntimeSources, freezeStudy, RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { validateCorpusPlan, selectPromptRows, corpusPlanFromTask } from '../../src/benchmark/corpus.mjs'
import { projectFiles } from '../../src/benchmark/export.mjs'
import { preparePromptSet, emptyPromptSetState } from '../../src/research-prompt-set.mjs'
import { developmentStarter } from './fixtures/research-benchmark-development.mjs'
import { newVarianceStudy, varianceInventory, varianceMark } from '../../src/research-variance.mjs'

const rows = () => Array.from({ length: 12 }, (_, i) => ({ taskId: 'case-' + i, disposition: 'eligible', dimensions: { group: i < 8 ? 'a' : 'b', family: 'family-' + i % 2 } }))
const policy = (kind, limit = 6, weights = {}) => ({ kind, limit, dimensions: ['group'], weights })
test('equal, proportional, weighted and exact allocations select exactly the requested distinct cases', () => {
  for (const [kind, weights, expected] of [
    ['equal', {}, [3, 3]], ['proportional', {}, [4, 2]], ['weighted', { '["a"]': 2, '["b"]': 1 }, [4, 2]], ['quotas', { '["a"]': 5, '["b"]': 1 }, [5, 1]],
  ]) {
    const result = selectPromptRows(rows(), policy(kind, 6, weights), 12)
    assert.deepEqual(result.issues, []); assert.deepEqual(result.groups.map(row => row.selected), expected)
    assert.equal(new Set(result.selectedIds).size, 6)
    result.groups.forEach(group => { assert.equal(group.inclusionProbability, group.selected / group.available); assert.equal(group.designWeight, group.available / group.selected) })
  }
})
test('random sampling is reproducible, seed-dependent and leaves source rows unchanged', () => {
  const input = rows(), before = structuredClone(input), first = selectPromptRows(input, policy('random'), 123)
  assert.deepEqual(first.selectedIds, selectPromptRows(input, policy('random'), 123).selectedIds)
  assert.notDeepEqual(first.selectedIds, selectPromptRows(input, policy('random'), 124).selectedIds)
  assert.deepEqual(input, before); assert.ok(first.groups.every(group => group.inclusionProbability === 0.5 && group.requested === null))
})
test('shortages, missing weights, stale strata and impossible counts do not silently redistribute', () => {
  for (const selection of [policy('equal', 12), policy('random', 13), policy('weighted', 6, { '["a"]': 1 }), policy('weighted', 6, { '["a"]': 1, '["b"]': 1, stale: 1 }), policy('quotas', 6, { '["a"]': 2, '["b"]': 2 })]) {
    const result = selectPromptRows(rows(), selection, 1)
    assert.ok(result.issues.length); assert.equal(result.selectedIds.length, 0)
  }
})
test('rounding has stable ties, zero weights exclude groups explicitly and joint strata retain typed values', () => {
  assert.deepEqual(selectPromptRows(rows(), policy('equal', 5), 1).groups.map(group => group.requested), [3, 2])
  const zero = selectPromptRows(rows(), policy('weighted', 5, { '["a"]': 1, '["b"]': 0 }), 1)
  assert.equal(zero.groups[1].selected, 0); assert.equal(zero.groups[1].inclusionProbability, 0); assert.equal(zero.groups[1].designWeight, null)
  assert.equal(selectPromptRows(rows(), { ...policy('proportional'), dimensions: ['group', 'family'] }, 1).groups.length, 4)
})
async function poolFixture() {
  const spec = developmentStarter(), base = spec.tasks[0]
  spec.tasks = Array.from({ length: 8 }, (_, i) => ({ ...structuredClone(base), id: 'source-' + i, familyId: 'family-' + i % 2, variables: { instruction: 'Case ' + i + ': answer precisely.' }, factors: { group: i < 6 ? 'a' : 'b' } }))
  const prepared = await preparePromptSet(spec, null, [], emptyPromptSetState())
  return { spec, plan: prepared.plan }
}
test('the compiled pool retains identities, families, split and complete exclusion provenance', async () => {
  const { spec, plan } = await poolFixture()
  plan.pool.tasks.push({ ...structuredClone(plan.pool.tasks[0]), id: 'duplicate' })
  plan.selection = { kind: 'proportional', limit: 4, dimensions: ['factor:group'], weights: {} }
  const result = await materializeCorpus({ ...spec, corpusPlan: plan })
  assert.equal(result.manifest.eligibleCount, 8); assert.equal(result.manifest.candidateCount, 9)
  assert.equal(result.manifest.candidates.at(-1).disposition, 'duplicate-excluded')
  assert.deepEqual(result.manifest.allocation.groups.map(group => group.selected), [3, 1])
  assert.ok(result.tasks.every(task => task.id.startsWith('source-') && task.familyId.startsWith('family-') && task.split === 'development'))
  const changed = structuredClone(plan); changed.pool.tasks[1].split = 'held-out'
  await assert.rejects(materializeCorpus({ ...spec, corpusPlan: changed }), /related prompts cannot cross/)
  const malformed = structuredClone(plan); malformed.selection.weights = { a: -1 }
  assert.throws(() => validateCorpusPlan(malformed), /nonnegative/)
})
test('selected omission studies generate actual variants into the pool and count shared controls once', async () => {
  const spec = developmentStarter(), source = { kind: 'task', id: spec.tasks[0].id }, inventory = await varianceInventory(spec, null, source)
  const entry = inventory.entries.find(row => row.path === 'root/task'), start = entry.text.indexOf('only ')
  const study = { ...newVarianceStudy('study-1'), name: 'Omit only', source, marks: [varianceMark(inventory, entry.key, start, start + 5)] }
  const result = await preparePromptSet(spec, null, [study], { ...emptyPromptSetState(), studies: [study.id] })
  assert.equal(result.manifest.eligibleCount, spec.tasks.length + 1)
  assert.equal(result.manifest.candidates.filter(row => row.disposition === 'duplicate-excluded').length, 1)
  assert.ok(result.manifest.candidates.some(row => row.dimensions?.omission === 'Omission variant'))
})
test('programmatic composition choices expose the entire pool before selecting X prompts', async () => {
  const spec = developmentStarter(), recipe = corpusPlanFromTask(spec.tasks[0])
  recipe.families[0].axes = [
    { id: 'wording', choices: Array.from({ length: 30 }, (_, i) => ({ id: 'wording-' + i, edits: [{ kind: 'variable', name: 'instruction', value: 'Instruction ' + i }] })) },
    { id: 'value', choices: Array.from({ length: 20 }, (_, i) => ({ id: 'value-' + i, edits: [{ kind: 'parameter', path: ['task'], name: 'a', value: i }] })) },
  ]
  const result = await preparePromptSet(spec, null, [], { ...emptyPromptSetState(), source: 'recipe' }, recipe)
  assert.equal(result.plan.pool.tasks.length, 600); assert.equal(result.manifest.eligibleCount, 600)
  assert.equal(result.manifest.status, 'allocation-unavailable', 'a census cannot silently exceed the 512-task run budget')
  result.plan.selection = { kind: 'random', limit: 100, dimensions: ['omission'], weights: {} }
  const selected = await materializeCorpus({ ...spec, corpusPlan: result.plan })
  assert.equal(selected.tasks.length, 100); assert.equal(selected.manifest.eligibleCount, 600)
  assert.equal(result.construction.manifest.candidateCount, 600)
})
test('pool selection exports, verifies and runs through the pinned standalone runtime', async t => {
  const { spec, plan } = await poolFixture()
  plan.selection = { kind: 'proportional', limit: 4, dimensions: ['factor:group'], weights: {} }
  spec.corpusPlan = plan; spec.tasks = (await materializeCorpus(spec)).tasks
  spec.conditions[0].adapter.responses = Object.fromEntries(spec.tasks.map(task => [task.id, '5']))
  const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8')])))
  const bound = await bindRuntimeSources(spec, sources), frozen = await freezeStudy(bound), files = await projectFiles(frozen, sources)
  assert.equal(frozen.corpus.manifest.allocation.groups.length, 2)
  const changed = structuredClone(bound); changed.tasks.reverse()
  await assert.rejects(freezeStudy(changed), /differ from their task recipe/)
  const root = await mkdtemp(resolve(tmpdir(), 'prompt-set-runtime-')); t.after(() => rm(root, { recursive: true, force: true }))
  for (const [file, text] of Object.entries(files)) { await mkdir(dirname(resolve(root, file)), { recursive: true }); await writeFile(resolve(root, file), text) }
  for (const command of ['verify', 'run']) {
    const result = spawnSync(process.execPath, [resolve(root, 'cli.mjs'), command, '--project', root], { encoding: 'utf8', timeout: 60000, windowsHide: true })
    assert.equal(result.status, 0, result.stderr || result.error?.message)
  }
  const events = (await readFile(resolve(root, 'results/attempts.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(events.filter(event => event.status === 'completed').length, 4)
})
