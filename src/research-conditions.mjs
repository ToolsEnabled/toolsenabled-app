// The condition language. One language, read at two moments.
//
// A reason evaluated once to choose a prompt and a reason evaluated over and
// over inside a running strategy are the same language; what differs is which
// facts are readable. At the generation moment the only facts are the row's own
// fields. At the run moment a child's lifecycle, its siblings, its own reason
// and elapsed time are readable too.
//
// A REASON DOES NOT CARRY ITS MOMENT. The moment comes from where the reason
// lives: a rule that chooses a composition is asked at generation, a policy on
// a container is asked at run. A reason holding a term its moment cannot read
// is refused by the name of the term, so there is nothing to label and nothing
// to keep in step.
//
// NOTHING HERE KNOWS A DOMAIN. The language says idle, active and done; what
// those mean for a body of work is the catalog's to say. No operator is defined
// in this file: the operators are ordinary content written in this language,
// and deleting every one of them leaves this file working.
import { invariant, object } from './benchmark/prompts.mjs'

const text = value => String(value ?? '').trim()

/* THE THREE STATES EVERY CHILD IS IN, and the only three. Started or not;
   finished or not. A catalog says what starting and finishing mean for it. */
export const LIFECYCLE = Object.freeze(['idle', 'active', 'done'])

/* The two moments. Named, because a refusal has to say which one the reason is
   being read at for the person to know what to change. */
export const MOMENTS = Object.freeze({ generation: 'generation', runtime: 'runtime' })
const MOMENT_WORDS = Object.freeze({
  generation: 'when the task is generated',
  runtime: 'while the work is running',
})

/* Comparisons, not categories. Each states what it does to two values and
   nothing about which values they should be. Lifted out of the routing model
   unchanged, so a draft written against the old model still compares the same
   way. */
export const VALUE_TESTS = Object.freeze([
  { id: 'is', label: 'is', needsValue: true },
  { id: 'is-not', label: 'is not', needsValue: true },
  { id: 'contains', label: 'contains', needsValue: true },
  { id: 'one-of', label: 'is one of (one per line)', needsValue: true },
  { id: 'at-least', label: 'is a number at least', needsValue: true },
  { id: 'at-most', label: 'is a number at most', needsValue: true },
  { id: 'present', label: 'has any value', needsValue: false },
  { id: 'absent', label: 'has no value', needsValue: false },
])
const VALUE_TEST_IDS = VALUE_TESTS.map(item => item.id)
export const testNeedsValue = id => VALUE_TESTS.find(item => item.id === id)?.needsValue === true

/* WHICH OF THE OTHER CHILDREN A CONDITION IS ASKING ABOUT. Slot order is
   already the order a person wrote the children in, so earlier and later are
   facts the composition already carries rather than anything new. */
export const SIBLING_SCOPES = Object.freeze([
  { id: 'all', label: 'the other children' },
  { id: 'earlier', label: 'the children before this one' },
  { id: 'later', label: 'the children after this one' },
])
export const SIBLING_QUANTIFIERS = Object.freeze([
  { id: 'any', label: 'any of them is' },
  { id: 'none', label: 'none of them is' },
  { id: 'every', label: 'all of them are' },
])
const SCOPE_IDS = SIBLING_SCOPES.map(item => item.id)
const QUANTIFIER_IDS = SIBLING_QUANTIFIERS.map(item => item.id)

/* THE TERMS, and what each one can be read at. A term readable only while the
   work is running is refused in a reason that chooses a prompt, by name. */
export const CONDITION_TERMS = Object.freeze([
  { id: 'always', label: 'always', moments: ['generation', 'runtime'] },
  { id: 'field', label: 'a field', moments: ['generation', 'runtime'] },
  { id: 'state', label: 'this child', moments: ['runtime'] },
  { id: 'siblings', label: 'the other children', moments: ['runtime'] },
  { id: 'children', label: 'the children of this one', moments: ['runtime'] },
  { id: 'reason', label: "this child's own reason", moments: ['runtime'] },
  { id: 'since', label: 'how long something has been true', moments: ['runtime'] },
  { id: 'ago', label: 'how long since something was last true', moments: ['runtime'] },
])
const TERM_IDS = CONDITION_TERMS.map(item => item.id)
const termNamed = id => CONDITION_TERMS.find(item => item.id === id)

/* The terms a surface may offer where it stands. The editor asks this rather
   than holding its own list, so a term can never be offered in a place where
   validation would then refuse it. */
export function termsForMoment(moment) {
  invariant(MOMENT_WORDS[moment], `${moment || '(blank)'} is not a moment a reason can be read at.`)
  return CONDITION_TERMS.filter(term => term.moments.includes(moment))
}

/* A CONDITION WRITTEN BEFORE THE LANGUAGE HAD TERMS still means what it said.
   Every rule in an existing draft is a field comparison and names no term, so a
   condition with a field and no term is read as one. */
export function readCondition(condition) {
  if (!object(condition)) return null
  const term = text(condition.term) || (condition.field !== undefined ? 'field' : '')
  return term ? { ...condition, term } : null
}
export const conditionTerm = condition => readCondition(condition)?.term || ''

/* ---- validation ---------------------------------------------------------
   Every refusal names the term, and where a term is out of its moment it says
   which moment it is being read at. A reason cannot be half-checked: a nested
   reason inside a duration is checked the same way at the same moment. */
export function validateCondition(condition, { moment = MOMENTS.generation, fields = null, where = 'This condition' } = {}) {
  invariant(MOMENT_WORDS[moment], `${where}: ${moment || '(blank)'} is not a moment a reason can be read at.`)
  const read = readCondition(condition)
  invariant(read, `${where}: choose what this asks about.`)
  invariant(TERM_IDS.includes(read.term), `${where}: ${read.term} is not something this language can ask about.`)
  const term = termNamed(read.term)
  invariant(term.moments.includes(moment),
    `${where}: ${term.label} can only be read ${MOMENT_WORDS[MOMENTS.runtime]}, and this reason is read ${MOMENT_WORDS[moment]}.`)

  const checkValueTest = (test, value, label) => {
    invariant(VALUE_TEST_IDS.includes(test), `${label}: choose one of the comparisons offered.`)
    if (testNeedsValue(test)) invariant(text(value), `${label}: enter the value to compare against.`)
  }
  const checkLifecycle = value => invariant(LIFECYCLE.includes(text(value)),
    `${where}: ${text(value) || '(blank)'} is not one of ${LIFECYCLE.join(', ')}.`)

  switch (read.term) {
    case 'always': break
    case 'field': {
      const name = text(read.field)
      invariant(name, `${where}: choose the field this asks about.`)
      if (fields) invariant(fields.has(name), `${where}: ${name} is not one of your fields.`)
      checkValueTest(read.test, read.value, where)
      break
    }
    case 'state':
      invariant(['is', 'is-not'].includes(read.test), `${where}: a child either is or is not in a state.`)
      checkLifecycle(read.is)
      break
    case 'siblings':
      invariant(SCOPE_IDS.includes(text(read.scope)), `${where}: choose which of the other children this asks about.`)
      invariant(QUANTIFIER_IDS.includes(text(read.quantifier)), `${where}: choose how many of them this asks about.`)
      checkLifecycle(read.is)
      break
    case 'children':
      // No scope: a container sees all of what it holds. Earlier and later are
      // facts about peers, and this term has no subject to be earlier than.
      invariant(QUANTIFIER_IDS.includes(text(read.quantifier)), `${where}: choose how many of them this asks about.`)
      checkLifecycle(read.is)
      break
    case 'reason':
      invariant(typeof read.holds === 'boolean', `${where}: say whether this child's own reason holds or does not.`)
      break
    case 'since': case 'ago': {
      // Both read a nested reason, so the nested reason is checked the same
      // way. Depth is not limited here; it is only ever reported.
      validateReason(read.of, { moment, fields, where: `${where}, the reason it times` })
      checkValueTest(read.test, read.value, `${where}, the length of time`)
      invariant(!testNeedsValue(read.test) || Number.isFinite(Number(text(read.value))),
        `${where}: ${text(read.value) || '(blank)'} is not a number of units.`)
      break
    }
    default: invariant(false, `${where}: ${read.term} is not something this language can ask about.`)
  }
  return read
}

/* A REASON IS A LIST OF CONDITIONS, ALL OF WHICH MUST HOLD. There is no
   grouping and there are no brackets: the owner asked for neither, and a ladder
   of rungs already carries the choice between alternatives. */
export function validateReason(reason, { moment = MOMENTS.generation, fields = null, where = 'This reason' } = {}) {
  invariant(Array.isArray(reason), `${where}: a reason is a list of conditions.`)
  invariant(reason.length, `${where}: a reason with no conditions would hold for everything. Add a condition, or use what happens otherwise instead.`)
  reason.forEach((condition, index) => validateCondition(condition, { moment, fields, where: `${where}, condition ${index + 1}` }))
  return reason
}

/* ---- reading ------------------------------------------------------------
   Facts are supplied by whoever is asking. A term whose fact is not being
   supplied is refused by name rather than read as false, because a condition
   that quietly answers no is indistinguishable from one that was never asked. */
function compareValues(actual, test, wanted, where) {
  const left = text(actual), right = text(wanted)
  switch (test) {
    case 'is': return left === right
    case 'is-not': return left !== right
    case 'contains': return left.includes(right)
    case 'one-of': return right.split('\n').map(text).filter(Boolean).includes(left)
    case 'present': return left !== ''
    case 'absent': return left === ''
    case 'at-least': case 'at-most': {
      const a = Number(left), b = Number(right)
      invariant(left !== '' && Number.isFinite(a), `${where} is ${left || 'empty'}, which is not a number, so it cannot be compared with ${right}.`)
      invariant(Number.isFinite(b), `${right} is not a number, so ${where} cannot be compared with it.`)
      return test === 'at-least' ? a >= b : a <= b
    }
    default: return invariant(false, `${where}: ${test} is not a comparison this language offers.`)
  }
}

/* How many of a set of children are in a state. Every over no children holds:
   a first child has no earlier sibling that could fail the test, and that is
   what lets a sequence begin. A container holding nothing is likewise already
   done rather than stuck. */
function quantify(read, picked) {
  const holds = child => text(child?.state) === text(read.is)
  if (text(read.quantifier) === 'every') return picked.every(holds)
  return text(read.quantifier) === 'none' ? !picked.some(holds) : picked.some(holds)
}

export function evaluateCondition(condition, facts = {}, { where = 'This condition' } = {}) {
  const read = readCondition(condition)
  invariant(read, `${where}: choose what this asks about.`)
  const need = (value, what) => {
    invariant(value !== undefined && value !== null, `${where}: this asks ${what}, and nothing here is reading one.`)
    return value
  }
  switch (read.term) {
    case 'always': return true
    case 'field': return compareValues(facts.values?.[text(read.field)], read.test, read.value, `${where}, ${text(read.field)}`)
    case 'state': {
      const state = text(need(facts.state, 'what state this child is in'))
      return read.test === 'is-not' ? state !== text(read.is) : state === text(read.is)
    }
    case 'siblings': {
      const peers = need(facts.siblings, 'about the other children')
      const index = need(facts.index, "this child's place among them")
      const scope = text(read.scope)
      const picked = peers.filter((peer, at) => at !== index
        && (scope === 'all' || (scope === 'earlier' ? at < index : at > index)))
      return quantify(read, picked)
    }
    case 'children':
      return quantify(read, need(facts.children, 'about the children of this one'))
    case 'reason': {
      const holds = need(facts.reason, "whether this child's own reason holds")
      return read.holds === true ? holds === true : holds !== true
    }
    case 'since': {
      const since = need(facts.since, 'how long a reason has been true')
      /* The reading is taken first, so whoever is keeping the history sees
         every evaluation -- including the ones where the reason stopped
         holding, which is when the record of it has to be cleared. */
      const held = since(read.of, facts)
      /* A DURATION PRESUPPOSES ITS REASON HOLDS NOW. How long something has
         been true has no answer while it is false, and without this a reason
         that is false would read as one that has just become true -- which
         would fire every gate keyed to the moment an event arrives. Decided
         here rather than trusted to the reading above. */
      if (!evaluateReason(read.of, facts, { where: `${where}, the reason it times` })) return false
      invariant(Number.isFinite(Number(held)), `${where}: how long that reason has been true was not a number.`)
      return compareValues(held, read.test, read.value, `${where}, the length of time`)
    }
    case 'ago': {
      const ago = need(facts.ago, 'how long ago a reason was last true')
      /* THE OPPOSITE PRESUPPOSITION TO `since`, AND THAT IS THE WHOLE POINT.
         `since` asks how long a reason has been true and has no answer while it
         is false. This asks how long it is SINCE a reason was last true, which
         is the question a window opened by an event actually asks: the event
         fires on one step and is gone on the next, and the window has to stay
         open across the steps where the reason is false. Asked with `since`,
         such a window shuts on the step after it opened -- measured, not
         supposed, in tools/test/research-conditions.test.mjs.
         A reason that has NEVER held is false here rather than infinitely long
         ago: no window was ever opened, and a number would say one was. */
      const elapsed = ago(read.of, facts)
      if (elapsed === null || elapsed === undefined) return false
      invariant(Number.isFinite(Number(elapsed)), `${where}: how long ago that reason was true was not a number.`)
      return compareValues(elapsed, read.test, read.value, `${where}, the length of time`)
    }
    default: return invariant(false, `${where}: ${read.term} is not something this language can ask about.`)
  }
}

export function evaluateReason(reason, facts = {}, { where = 'This reason' } = {}) {
  invariant(Array.isArray(reason), `${where}: a reason is a list of conditions.`)
  return reason.every((condition, index) => evaluateCondition(condition, facts, { where: `${where}, condition ${index + 1}` }))
}

/* ---- saying it back -----------------------------------------------------
   The surface prints a reason as the person wrote it, so a reason that is hard
   to read on the page is hard to read here too, deliberately. */
export function describeCondition(condition) {
  const read = readCondition(condition)
  if (!read) return ''
  const test = VALUE_TESTS.find(item => item.id === read.test)
  switch (read.term) {
    case 'always': return 'always'
    case 'field': return `${text(read.field)} ${test?.label || read.test}${testNeedsValue(read.test) ? ` ${text(read.value)}` : ''}`
    case 'state': return `this child is ${read.test === 'is-not' ? 'not ' : ''}${text(read.is)}`
    case 'siblings': {
      const scope = SIBLING_SCOPES.find(item => item.id === text(read.scope))
      const quantifier = SIBLING_QUANTIFIERS.find(item => item.id === text(read.quantifier))
      return `of ${scope?.label || text(read.scope)}, ${quantifier?.label || text(read.quantifier)} ${text(read.is)}`
    }
    case 'children': {
      const quantifier = SIBLING_QUANTIFIERS.find(item => item.id === text(read.quantifier))
      return `of the children of this one, ${quantifier?.label || text(read.quantifier)} ${text(read.is)}`
    }
    case 'reason': return `this child's own reason ${read.holds === true ? 'holds' : 'does not hold'}`
    case 'since': return `${describeReason(read.of)} has been true for ${test?.label || read.test} ${text(read.value)}`
    case 'ago': return `it has been ${test?.label || read.test} ${text(read.value)} since ${describeReason(read.of)} was last true`
    default: return ''
  }
}
export const describeReason = reason => (Array.isArray(reason) ? reason.map(describeCondition).filter(Boolean).join(' and ') : '')
