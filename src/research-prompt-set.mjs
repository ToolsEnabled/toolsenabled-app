import { canonical, invariant } from './benchmark/prompts.mjs'
import { buildVarianceStudy } from './research-variance.mjs'
import { materializeCorpus } from './benchmark/study.mjs'
import { expandComposition } from './research-routing.mjs'
import { nestingSets } from './research-nesting.mjs'

export const emptyPromptSetState = () => ({ source: 'current', sets: [], studies: [], method: 'all', count: '100', seed: '42', dimensions: ['omission'], weights: {}, rationale: '' })
// The saved sets a task set can draw from: composition runs and nested runs.
export const promptSetSources = (routing, catalog) => nestingSets(routing, catalog)
const slug = value => String(value ?? '').toLocaleLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'set'
// Every composition of the chosen sets becomes a candidate task: the
// composition expanded to its prompt tree, with no input or expected result
// yet, exactly what "Add this composition as a task" makes one at a time.
export function tasksFromSets(routing, catalog, names) {
  const sets = nestingSets(routing, catalog), used = new Set(), tasks = []
  for (const name of names) {
    const set = sets.find(item => item.name === name)
    invariant(set, `The set "${name}" is no longer in this project. Choose the sets again.`)
    set.members.forEach((composition, index) => {
      let id = `${slug(name)}-${index + 1}`, suffix = 1
      if (!/^[a-z]/.test(id)) id = 'set-' + id
      while (used.has(id)) id = `${slug(name)}-${index + 1}-${suffix++}`
      used.add(id)
      // The set rides along as a factor, so the distribution can group by it.
      tasks.push({ id, root: expandComposition(composition, routing, { catalog }), input: null, expected: null, split: 'development', factors: { set: name }, origin: { kind: 'set', set: name, composition } })
    })
  }
  return tasks
}
export const detachedPrompt = task => {
  const { generation, ...copy } = structuredClone(task)
  if (generation) copy.origin = { kind: 'detached-corpus', generation }
  return copy
}
export const promptSetBinding = (spec, routing, studies, recipe) => canonical({ domain: spec.domain, catalog: spec.catalog, tasks: spec.tasks, pool: spec.corpusPlan ?? null, grading: spec.protocol.grading, routing: routing ?? null, studies, recipe: recipe ?? null })
export async function preparePromptSet(spec, routing, studies, state, recipe = null) {
  invariant(!spec.auditPlan && !spec.experimentTemplate, 'This benchmark generates its tasks through its specialized module. Open a prompt benchmark to build a prompt pool.')
  let base = spec.tasks, construction = null
  if (state.source === 'sets') {
    invariant(Array.isArray(state.sets) && state.sets.length, 'Choose at least one saved set. Sets are made on Composition and Nesting.')
    base = tasksFromSets(routing, spec.catalog, state.sets)
    invariant(base.length, 'The chosen sets hold no compositions.')
  } else if (state.source === 'retained') {
    invariant(spec.corpusPlan?.pool, 'There is no retained prompt pool. Choose current tasks.')
    base = spec.corpusPlan.pool.tasks
  } else if (state.source === 'recipe') {
    invariant(recipe && !recipe.pool, 'Prepare composition choices in Advanced generation first.')
    const generated = await materializeCorpus({ ...spec, corpusPlan: recipe }, { enumerateOnly: true })
    invariant(generated.manifest.status === 'ready', 'The advanced construction has no eligible prompts. Inspect its fields and exclusions.')
    base = generated.tasks; construction = { recipe: structuredClone(recipe), manifest: generated.manifest }
  } else invariant(state.source === 'current', 'Choose a prompt pool source.')
  const tasks = base.map(detachedPrompt), baseSpec = { ...spec, tasks: base }, used = new Set(tasks.map(task => task.id))
  for (const id of state.studies) {
    const study = studies.find(row => row.id === id)
    invariant(study, 'A selected variance study is no longer available.')
    const generated = await buildVarianceStudy(baseSpec, routing, study, { forLibrary: true })
    for (const [index, task] of generated.tasks.entries()) {
      let name = `pool-${id.slice(0, 40)}-${index + 1}`, suffix = 1
      while (used.has(name)) name = `pool-${id.slice(0, 34)}-${index + 1}-${suffix++}`
      used.add(name); tasks.push({ ...detachedPrompt(task), id: name })
    }
  }
  invariant(tasks.length, 'Add tasks from Composition or Nesting, or select a variance study.')
  invariant(tasks.length <= 4096, 'The candidate pool exceeds 4,096 prompts. Narrow the source selection.')
  const plan = { version: 1, seed: 42, rationale: 'Inspecting the authored prompt pool before selection.', families: [], coverage: [],
    pool: { version: 1, tasks }, selection: { kind: 'all', limit: 512, dimensions: ['omission'], weights: {} } }
  const generated = await materializeCorpus({ ...spec, corpusPlan: plan })
  return { plan, manifest: generated.manifest, construction }
}
