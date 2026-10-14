// Named compositions and the rules that choose between them.
//
// The shape here is the owner's, not a domain's. A composition is a tree of
// snippet references; any slot in it may hold another named composition, and
// that composition may hold another, to any depth. Nothing in this file knows
// what a composition is for: every name, every field, every value and every
// composition identifier is the person's own word. The only words this file
// supplies are the comparison tests below, and they compare values without
// having any opinion about what is being compared.
//
// A routing draft is authoring state. It generates ordinary tasks and is never
// part of a frozen study, so a study's schema is unchanged by its existence.
import { invariant, object } from './benchmark/prompts.mjs'
import { MOMENTS, VALUE_TESTS, evaluateReason, validateReason } from './research-conditions.mjs'

const ID = /^[a-z][a-z0-9_-]{0,63}$/
const NAME_LIMIT = 64
const text = value => String(value ?? '').trim()
const hasControl = value => [...value].some(character => character.codePointAt(0) < 32)

/* The comparisons a rule may use are the shared language's, not this file's.
   A rule that chooses a composition is read at the generation moment, so the
   language offers it field comparisons and refuses anything that could only be
   answered while the work is running. */
export { VALUE_TESTS as ROUTING_TESTS } from './research-conditions.mjs'

export function createRoutingDraft(task) {
  const name = text(task?.id) || 'composition-1'
  return {
    version: 1,
    fields: [],
    compositions: task?.root ? [{ name, node: structuredClone(task.root) }] : [],
    // PROMPT C. Named sets of rules, referable from a rung the way a composition
    // is referable from a place. The outermost set is draft.rules below.
    decisions: [],
    rules: [],
    otherwise: task?.root ? { composition: name } : null,
    rows: [{ id: 'row-1', values: {} }],
  }
}

/* PROMPT C. WHAT A RUNG CHOOSES, IN ONE SHAPE.
 * Either a composition to use or another set of rules to ask, exactly as a
 * place in a composition holds either a snippet or another composition. A bare
 * name is read as a composition, so a draft written before rule sets existed
 * still means what it said. */
export function outcomeFrom(value) {
  if (typeof value === 'string' && text(value)) return { composition: text(value) }
  if (!object(value)) return null
  if (text(value.decision)) return { decision: text(value.decision) }
  if (text(value.composition)) return { composition: text(value.composition) }
  return null
}
export const ruleOutcome = rule => outcomeFrom(rule?.then ?? rule?.composition)
export const fallbackOutcome = set => outcomeFrom(set?.otherwise)
const decisionNamed = (draft, name) => (draft?.decisions || []).find(item => text(item.name) === text(name))
const rootSet = draft => ({ name: '', rules: draft?.rules || [], otherwise: draft?.otherwise })
const setLabel = name => (text(name) ? `the rules named ${text(name)}` : 'the first rules')

/* Every set reachable from the outermost one, first occurrence first, with the
 * rung that reached it. The surface draws them in this order, and a set nobody
 * reaches is reported separately rather than disappearing. */
export function reachableDecisions(draft) {
  const found = [], seen = new Set()
  const walk = set => {
    for (const outcome of [...(set.rules || []).map(ruleOutcome), fallbackOutcome(set)]) {
      const name = outcome?.decision
      if (!name || seen.has(name)) continue
      const next = decisionNamed(draft, name)
      if (!next) continue
      seen.add(name); found.push(next); walk(next)
    }
  }
  walk(rootSet(draft))
  return found
}

/* HOW DEEP A DECISION GOES once its references are resolved, counting itself as
 * level 1. Reported, never limited: the owner's model is arbitrarily large. A
 * loop is refused by the names that form it, the way a composition loop is. */
export function decisionDepth(name, draft, { active = [] } = {}) {
  const here = text(name)
  const set = here ? decisionNamed(draft, here) : rootSet(draft)
  invariant(set, `There is no set of rules named ${here || '(blank)'}.`)
  invariant(!active.includes(here), `These sets of rules contain each other: ${[...active, here].map(setLabel).join(' → ')}. Break the loop before generating tasks.`)
  const trail = [...active, here]
  const below = [...(set.rules || []).map(ruleOutcome), fallbackOutcome(set)]
    .filter(outcome => outcome?.decision)
    .map(outcome => decisionDepth(outcome.decision, draft, { active: trail }))
  return 1 + Math.max(0, ...below)
}

function validateNode(node, label, { names, catalog }) {
  invariant(object(node), `${label}: choose a snippet or a saved composition.`)
  if (node.composition !== undefined) {
    invariant(Object.keys(node).every(key => ['composition', 'promptOmissions', 'variables'].includes(key)), `${label}: a saved composition reference names a composition and optional prompt omissions or variables.`)
    invariant(names.has(text(node.composition)), `${label}: there is no saved composition named ${text(node.composition) || '(blank)'}.`)
    return
  }
  invariant(typeof node.use === 'string' && node.use, `${label}: choose a snippet or a saved composition.`)
  if (catalog) invariant(catalog.some(bundle => bundle.id === node.use), `${label}: this draft has no snippet with the identifier ${node.use}.`)
  invariant(node.params === undefined || object(node.params), `${label}: local values must be an object.`)
  invariant(node.slots === undefined || object(node.slots), `${label}: child connections must be an object.`)
  for (const [slot, child] of Object.entries(node.slots || {})) validateNode(child, `${label} / ${slot}`, { names, catalog })
}

export function validateRouting(draft, { catalog = null } = {}) {
  invariant(object(draft) && draft.version === 1, 'This routing draft was written by a different version of this page.')
  invariant(Array.isArray(draft.fields) && Array.isArray(draft.compositions) && Array.isArray(draft.rules) && Array.isArray(draft.rows), 'A routing draft needs its fields, compositions, rules and rows.')
  invariant(draft.decisions === undefined || Array.isArray(draft.decisions), 'Named sets of rules must be a list.')

  const seenField = new Set()
  for (const field of draft.fields) {
    const name = text(field)
    invariant(name, 'Name every field before routing on it.')
    invariant(name.length <= NAME_LIMIT && !hasControl(name), `Use a field name of at most ${NAME_LIMIT} characters, without line breaks: ${name}.`)
    invariant(!seenField.has(name), `Two fields are both named ${name}. Rename one of them.`)
    seenField.add(name)
  }

  const names = new Set()
  for (const composition of draft.compositions) {
    invariant(object(composition), 'Every saved composition needs a name and a tree.')
    const name = text(composition.name)
    invariant(name, 'Name every saved composition.')
    invariant(name.length <= NAME_LIMIT && !hasControl(name), `Use a composition name of at most ${NAME_LIMIT} characters, without line breaks: ${name}.`)
    invariant(!names.has(name), `Two saved compositions are both named ${name}. Rename one of them.`)
    names.add(name)
  }
  for (const composition of draft.compositions) validateNode(composition.node, `Composition ${text(composition.name)}`, { names, catalog })
  // Refuse a loop by the names that form it, so the person can see which
  // reference to change. Depth itself is not limited here.
  for (const composition of draft.compositions) expandComposition(text(composition.name), draft, { catalog })

  /* PROMPT C. EVERY SET OF RULES IS CHECKED THE SAME WAY, at every level.
     A rung chooses a composition or another set; both are checked by name, so a
     reference that no longer resolves is named rather than discovered when a
     row runs through it. */
  const decisions = draft.decisions || []
  const setNames = new Set()
  for (const decision of decisions) {
    invariant(object(decision) && Array.isArray(decision.rules), 'Every set of rules needs a name and its rules.')
    const name = text(decision.name)
    invariant(name, 'Name every set of rules.')
    invariant(name.length <= NAME_LIMIT && !hasControl(name), `Use a name of at most ${NAME_LIMIT} characters, without line breaks: ${name}.`)
    invariant(!setNames.has(name), `Two sets of rules are both named ${name}. Rename one of them.`)
    setNames.add(name)
  }

  const checkOutcome = (outcome, where, required) => {
    if (!outcome) { invariant(!required, `${where}: choose a composition or another set of rules.`); return }
    if (outcome.decision) {
      invariant(setNames.has(outcome.decision), `${where}: ${outcome.decision} is not one of your sets of rules.`)
      return
    }
    invariant(names.has(outcome.composition), `${where}: choose one of your saved compositions; ${outcome.composition || '(blank)'} is not one.`)
  }
  const checkSet = (set, label) => {
    set.rules.forEach((rule, index) => {
      const where = `${label} rule ${index + 1}`
      invariant(object(rule) && Array.isArray(rule.tests), `${where}: a rule needs its tests.`)
      checkOutcome(ruleOutcome(rule), where, true)
      invariant(rule.tests.length, `${where}: a rule with no test would match every row. Add a test, or use what happens otherwise instead.`)
      validateReason(rule.tests, { moment: MOMENTS.generation, fields: seenField, where })
    })
    checkOutcome(fallbackOutcome(set), `${label} otherwise`, false)
  }
  checkSet({ rules: draft.rules, otherwise: draft.otherwise }, 'Rule set:')
  for (const decision of decisions) checkSet(decision, `Set ${text(decision.name)}:`)
  // A loop between sets is refused by the names that form it. Depth is not
  // limited here either; it is only reported.
  decisionDepth('', draft)
  for (const decision of decisions) decisionDepth(text(decision.name), draft)

  const seenRow = new Set()
  draft.rows.forEach((row, index) => {
    invariant(object(row) && object(row.values), `Row ${index + 1}: a row needs its field values.`)
    const id = text(row.id)
    invariant(ID.test(id), `Row ${index + 1}: give the task a lowercase identifier of letters, digits, - or _ (${id || 'blank'} is not one).`)
    invariant(!seenRow.has(id), `Two rows are both named ${id}. Rename one of them.`)
    seenRow.add(id)
  })
  return draft
}

// Resolve a saved composition into a plain reference tree. A composition may
// contain another composition at any depth; the only thing refused is a loop.
export function expandComposition(name, draft, { catalog = null, active = [] } = {}) {
  const wanted = text(name)
  const composition = (draft?.compositions || []).find(item => text(item.name) === wanted)
  invariant(composition, `There is no saved composition named ${wanted || '(blank)'}.`)
  invariant(!active.includes(wanted), `These saved compositions contain each other: ${[...active, wanted].join(' → ')}. Break the loop before generating tasks.`)
  const trail = [...active, wanted]
  const expand = node => {
    if (node?.composition !== undefined) {
      const result = expandComposition(node.composition, draft, { catalog, active: trail })
      if (node.variables) result.variables = { ...(result.variables || {}), ...structuredClone(node.variables) }
      if (node.promptOmissions) result.promptOmissions = [...(result.promptOmissions ? [result.promptOmissions].flat() : []), ...[structuredClone(node.promptOmissions)].flat()]
      return result
    }
    invariant(object(node) && typeof node.use === 'string' && node.use, `Composition ${wanted} still has an empty place in it. Choose a snippet or a saved composition there.`)
    const slots = Object.entries(node?.slots || {})
    return {
      use: node.use,
      ...(node.variables ? { variables: structuredClone(node.variables) } : {}),
      ...(node.promptOmissions ? { promptOmissions: structuredClone(node.promptOmissions) } : {}),
      ...(node.params && Object.keys(node.params).length ? { params: structuredClone(node.params) } : {}),
      ...(slots.length ? { slots: Object.fromEntries(slots.map(([slot, child]) => [slot, expand(child)])) } : {}),
    }
  }
  return expand(composition.node)
}

// How deep a saved composition actually goes once its references are resolved,
// counting the root as level 1. Reported to the person rather than limited.
export function compositionDepth(name, draft, options = {}) {
  const depth = node => 1 + Math.max(0, ...Object.values(node.slots || {}).map(depth))
  return depth(expandComposition(name, draft, options))
}


/* PROMPT C. THE FIRST RULE WHOSE TESTS ALL HOLD DECIDES, AT EVERY LEVEL.
 * What it decides is either a composition, which ends the walk, or another set
 * of rules, which is then asked the same way. No rule matching is an answer
 * that has to be stated at whatever level it happens, never a quietly chosen
 * default, and the walk reports every rung it took so a row can be traced
 * rather than guessed at. */
export function routeRow(draft, values, { label = 'This row' } = {}) {
  const path = []
  const seen = []
  let set = rootSet(draft)
  for (;;) {
    const here = text(set.name)
    invariant(!seen.includes(here), `${label} sends these sets of rules through each other: ${[...seen, here].map(setLabel).join(' → ')}. Break the loop before generating tasks.`)
    seen.push(here)
    const rules = set.rules || []
    const index = rules.findIndex(rule => evaluateReason(rule.tests || [], { values }, { where: label || 'This rule' }))
    const outcome = index >= 0 ? ruleOutcome(rules[index]) : fallbackOutcome(set)
    invariant(outcome, index >= 0
      ? `${label} reached rule ${index + 1} of ${setLabel(here)}, which chooses nothing. Point it at a composition or at another set of rules.`
      : `${label} matches none of the ${rules.length} rule${rules.length === 1 ? '' : 's'} in ${setLabel(here)}, and nothing is chosen there for when none do. Add a rule that matches it or choose what happens otherwise.`)
    /* The step says which set answered and with which rung. The outcome is
       kept under its own names, because spreading it here let a chosen set
       overwrite the set that chose it and every trace read one level short. */
    path.push({ decision: here, rule: index >= 0 ? index + 1 : null, ...(outcome.composition ? { composition: outcome.composition } : { sends: outcome.decision }) })
    if (outcome.composition) return { composition: outcome.composition, rule: path[0].rule, path }
    const next = decisionNamed(draft, outcome.decision)
    invariant(next, `${label} is sent to ${setLabel(outcome.decision)}, which does not exist. Choose an existing set of rules.`)
    set = next
  }
}

/* The path a row took, as one line a person can read: which rung of which set
 * answered, all the way down to the composition it ended at. */
export function describeRoute(path = []) {
  return path.map((step, index) => {
    const where = index === 0 ? '' : `${setLabel(step.decision)}: `
    const rung = step.rule === null ? 'otherwise' : `rule ${step.rule}`
    return `${where}${rung}`
  }).join(' → ')
}

// Ordinary tasks: a root the routing chose, and the person's own fields carried
// through as task variables, so the same words they route on are the words the
// composition can quote.
export function routedTasks(draft, { catalog = null, split = 'development' } = {}) {
  validateRouting(draft, { catalog })
  invariant(draft.rows.length, 'Add at least one row of field values before generating tasks.')
  return draft.rows.map(row => {
    const decision = routeRow(draft, row.values, { label: `Row ${text(row.id)}` })
    return {
      id: text(row.id),
      root: expandComposition(decision.composition, draft, { catalog }),
      input: null,
      expected: '',
      split,
      ...(Object.keys(row.values || {}).length ? { variables: Object.fromEntries(Object.entries(row.values).map(([key, value]) => [key, text(value)])) } : {}),
    }
  })
}

// What each row would do, for showing the decision before anything is generated.
// PROMPT C: the whole path, not only the rung that started it, because a nested
// decision a person cannot trace is a decision they cannot correct.
export function routingPreview(draft, { catalog = null } = {}) {
  return (draft?.rows || []).map(row => {
    try {
      const decision = routeRow(draft, row.values, { label: `Row ${text(row.id)}` })
      return {
        id: text(row.id), composition: decision.composition, rule: decision.rule, path: decision.path,
        route: describeRoute(decision.path), depth: compositionDepth(decision.composition, draft, { catalog }), error: '',
      }
    } catch (error) { return { id: text(row.id), composition: '', rule: null, path: [], route: '', depth: 0, error: error.message } }
  })
}
