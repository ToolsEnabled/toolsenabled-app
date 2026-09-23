// The lifecycle, and a deterministic reading of a composition against it.
//
// A container holds children; every child is idle, active or done; and the
// container's policy is three reasons in the shared language:
//
//   may-act  asked of each child in turn: may this one act now
//   done     asked of the container: is what I hold finished
//   reset    asked of the container: should everything I hold go back to idle
//
// WHY THREE AND NOT ONE. May-act alone cannot say when the container itself is
// finished, and a container that cannot report done to its parent cannot nest.
// Nor can may-act express a reset: not being allowed to act is not the same as
// being put back, because a child that is done must stay done while it is not
// acting.
//
// NO OPERATOR IS DEFINED HERE. This file runs a policy; it does not know any.
// Deleting every policy a person has written leaves this file working and
// leaves compositions with nothing to run, which is the correct answer rather
// than a built-in default.
import { invariant, object } from './benchmark/prompts.mjs'
import { MOMENTS, evaluateReason, validateReason } from './research-conditions.mjs'

export const POLICY_CLAUSES = Object.freeze(['mayAct', 'done', 'reset'])
const CLAUSE_WORDS = Object.freeze({
  mayAct: 'which of its children may act',
  done: 'when it is finished',
  reset: 'when what it holds goes back to the start',
})
const REQUIRED_CLAUSES = Object.freeze(['mayAct', 'done'])

const text = value => String(value ?? '').trim()
export const isContainer = node => Array.isArray(node?.children)

/* WITHIN A STEP, RESET THEN ACT THEN FINISH.
 * Acting before finishing is the conservative order and the one the owner's
 * material implies: a child that finishes on a step hands over on the step
 * after, not the same one. The other order would run a whole sequence of
 * children inside a single moment whenever each finished immediately. */
const PHASES = Object.freeze(['reset', 'act', 'finish'])

export function validatePolicy(policy, { where = 'This container', fields = null } = {}) {
  invariant(object(policy), `${where}: choose a policy saying ${CLAUSE_WORDS.mayAct}. A container with no policy cannot be asked.`)
  for (const clause of REQUIRED_CLAUSES) {
    invariant(Array.isArray(policy[clause]) && policy[clause].length,
      `${where}: this policy does not say ${CLAUSE_WORDS[clause]}.`)
  }
  for (const clause of POLICY_CLAUSES) {
    if (policy[clause] === undefined || policy[clause] === null) continue
    validateReason(policy[clause], { moment: MOMENTS.runtime, fields, where: `${where}, ${CLAUSE_WORDS[clause]}` })
  }
  return policy
}

/* Every container is checked, by its own path, before anything runs. A
   composition that would refuse halfway through a run refuses before it
   starts instead. */
export function validateComposition(root, { fields = null } = {}) {
  const seen = new Set()
  const walk = node => {
    invariant(object(node), 'Every part of a composition is a node.')
    const path = text(node.path)
    invariant(path, 'Every node needs its own path.')
    invariant(!seen.has(path), `Two nodes are both at ${path}. A path names one node.`)
    seen.add(path)
    if (node.reason !== undefined) validateReason(node.reason, { moment: MOMENTS.runtime, fields, where: `${path}, its own reason` })
    if (!isContainer(node)) return
    validatePolicy(node.policy, { where: `The container at ${path}`, fields })
    node.children.forEach(walk)
  }
  walk(root)
  return root
}

const nodesOf = root => {
  const all = []
  const walk = (node, parent, index) => {
    all.push({ node, parent, index })
    if (isContainer(node)) node.children.forEach((child, at) => walk(child, node, at))
  }
  walk(root, null, -1)
  return all
}

/* HOW LONG A REASON HAS BEEN CONTINUOUSLY TRUE, counted in steps. A step is
   whatever the catalog says a step is; this file only counts them. The record
   is cleared the moment the reason stops holding, which is what makes a
   duration of zero mean the step it became true and nothing else. */
function durations() {
  const since = new Map()
  const last = new Map()
  return {
    note(key, step, holds) {
      if (!holds) since.delete(key)
      else if (!since.has(key)) since.set(key, step)
      if (holds) last.set(key, step)
    },
    held(key, step) { return since.has(key) ? step - since.get(key) : 0 },
    /* AND WHEN IT WAS LAST TRUE, kept from the same observation rather than a
       second one. A window opened by an event outlives the event: the record of
       how long a reason has been true is cleared the moment it stops holding,
       and this one deliberately is not. Null until it has held once, because a
       window nobody opened is not a window that opened long ago. */
    ago(key, step) { return last.has(key) ? step - last.get(key) : null },
  }
}

export function runLifecycle(root, steps, { fields = null } = {}) {
  validateComposition(root, { fields })
  invariant(Array.isArray(steps), 'A run is a list of steps.')

  const all = nodesOf(root)
  const state = new Map(all.map(({ node }) => [node.path, 'idle']))
  state.set(root.path, 'active')
  const clock = durations()
  const trace = []

  /* One key for both clocks, named once. The separator is a character no path
     can contain, written as an escape and never as the byte itself. */
  const clockKey = (node, reason) => `${node.path}\u0000${JSON.stringify(reason)}`
  const stateOf = node => ({ state: state.get(node.path) })
  const childStates = node => (isContainer(node) ? node.children.map(stateOf) : [])

  for (const [index, step] of steps.entries()) {
    invariant(object(step), `Step ${index + 1}: a step says what is true at that moment.`)
    const values = step.values || {}
    const record = { step: index, values, mayAct: {}, reset: [], acted: [], finished: [], states: {} }

    /* The facts a reason is read against. Which of them are supplied is what
       makes a term readable here; a term whose fact is missing is refused by
       name rather than read as no. */
    const factsFor = (node, parent, at, { withOwnReason = true } = {}) => {
      const facts = {
        values,
        state: state.get(node.path),
        children: isContainer(node) ? childStates(node) : undefined,
        since: (reason, current) => {
          const key = clockKey(node, reason)
          const holds = evaluateReason(reason, current)
          clock.note(key, index, holds)
          return clock.held(key, index)
        },
        /* How long SINCE a reason was last true, which is not how long it HAS
           been true. An event fires on one step and is gone on the next; a
           window it opened has to outlive it. Both readers note the same
           observation, so the history is one history. */
        ago: (reason, current) => {
          const key = clockKey(node, reason)
          clock.note(key, index, evaluateReason(reason, current))
          return clock.ago(key, index)
        },
      }
      if (parent) { facts.siblings = childStates(parent); facts.index = at }
      if (withOwnReason) {
        const own = node.reason
          // A node's own reason is read without itself in the facts, so a
          // reason that refers to itself is refused by name rather than looping.
          ? evaluateReason(node.reason, factsFor(node, parent, at, { withOwnReason: false }), { where: `${node.path}, its own reason` })
          : step.reasons?.[node.path]
        if (own !== undefined) facts.reason = own
      }
      return facts
    }

    // 1. RESET, outermost first, so an outer gate closing puts back everything
    //    inside it including whatever a nested container holds.
    for (const { node, parent, index: at } of all) {
      if (!isContainer(node) || !node.policy.reset) continue
      const holds = evaluateReason(node.policy.reset, factsFor(node, parent, at), { where: `The container at ${node.path}, ${CLAUSE_WORDS.reset}` })
      if (!holds) continue
      const inside = nodesOf(node).slice(1)
      for (const { node: child } of inside) state.set(child.path, 'idle')
      record.reset.push({ path: node.path, put: inside.map(({ node: child }) => child.path) })
    }

    /* 2. ACT. Children are asked in slot order and the answer is applied before
          the next child is asked, which is the whole of the tiebreak: once one
          child has claimed a step, the child after it sees a sibling already
          active. Asking them all against one frozen picture would let two
          children claim the same exclusive turn. */
    const descend = (node, parent, at) => {
      if (!isContainer(node)) return
      // A container that is not itself acting does not let what it holds act.
      if (parent && state.get(node.path) !== 'active') return
      node.children.forEach((child, childAt) => {
        const may = evaluateReason(node.policy.mayAct, factsFor(child, node, childAt),
          { where: `The container at ${node.path}, ${CLAUSE_WORDS.mayAct}` })
        record.mayAct[child.path] = may
        if (may && state.get(child.path) === 'idle') { state.set(child.path, 'active'); record.acted.push(child.path) }
        descend(child, node, childAt)
      })
    }
    descend(root, null, -1)

    // 3. FINISH, innermost first: a container's own completion reads the states
    //    its children have just reached, not the ones they had a step ago.
    for (const { node, parent, index: at } of [...all].reverse()) {
      if (state.get(node.path) !== 'active') continue
      const finished = isContainer(node)
        ? evaluateReason(node.policy.done, factsFor(node, parent, at), { where: `The container at ${node.path}, ${CLAUSE_WORDS.done}` })
        : step.finished?.[node.path] === true
      if (finished) { state.set(node.path, 'done'); record.finished.push(node.path) }
    }

    for (const { node } of all) record.states[node.path] = state.get(node.path)
    trace.push(record)
  }

  return { trace, states: Object.fromEntries(state) }
}

/* THE ANSWER KEY IN WORDS. A trace has to be enough to say what the correct
   behaviour was, not only to produce it, so every step says what it put back,
   what acted, what finished and where everything stood afterwards. */
export function describeTrace(trace) {
  return trace.map(record => {
    const said = []
    for (const put of record.reset) said.push(`put back ${put.put.join(', ') || 'nothing'} (${put.path})`)
    said.push(record.acted.length ? `acted ${record.acted.join(', ')}` : 'nothing acted')
    if (record.finished.length) said.push(`finished ${record.finished.join(', ')}`)
    return `step ${record.step + 1}: ${said.join('; ')}`
  }).join('\n')
}

export { PHASES }
