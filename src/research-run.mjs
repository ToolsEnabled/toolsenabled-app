// Running a composed prompt, rather than only reading it.
//
// A composition already says what it holds and in what order. What it has not
// said until now is how the thing holding them decides who acts, so the prose
// in a template ("the first slot whose buy reason is satisfied claims sole
// ownership") had no executable counterpart and nothing could say whether a
// model obeyed it.
//
// A POLICY IS CONTENT, NOT SCHEMA. It rides in a bundle's own semantics object,
// which the compiler already carries through to every node and already runs
// parameter substitution over. Nothing in the composition representation
// changes, so a study frozen before policies existed is still a valid study and
// a bundle without one is still a valid bundle.
//
// The slot order a person wrote is the order children are asked in. That is not
// a new idea here: the compiler already builds a node's ports from its bundle's
// declared slot order, so the tiebreak is the order already on the page.
import { invariant, object } from './benchmark/prompts.mjs'
import { runLifecycle, validatePolicy } from './research-lifecycle.mjs'

export const policyOf = node => node?.semantic?.policy ?? null
export const reasonOf = node => node?.semantic?.reason ?? null

/* Turn a compiled composition into something the lifecycle can run. A node with
   places is a container and needs a policy; a node with none is a leaf and acts
   on its own reason. */
export function lifecycleFromComposition(ir, { fields = null } = {}) {
  invariant(object(ir) && Array.isArray(ir.nodes) && ir.nodes.length, 'A composition is its list of nodes.')
  const byPath = new Map(ir.nodes.map(node => [node.path, node]))

  const build = node => {
    const made = { path: node.path }
    const reason = reasonOf(node)
    if (reason) made.reason = reason
    const places = node.ports || []
    if (!places.length) return made

    const policy = policyOf(node)
    /* REFUSED BY NAME, never quietly treated as one of the operators a person
       happens to have written. A silent default would be that operator built
       into the software, and deleting it would stop being possible. The bundle
       is named as well as the place, because the bundle is what to edit. */
    invariant(object(policy),
      `The container at ${node.path} uses ${node.bundle.id}, which does not say which of its children may act. `
      + `Give ${node.bundle.id} a policy, or take what is inside it out.`)
    validatePolicy(policy, { where: `The container at ${node.path}, which uses ${node.bundle.id}`, fields })

    made.policy = policy
    made.children = places.map(port => {
      const child = byPath.get(port.path)
      invariant(child, `${node.path}: nothing is in its ${port.name} place.`)
      return build(child)
    })
    return made
  }

  const root = byPath.get(ir.rootPath || 'root')
  invariant(root, 'A composition needs its root.')
  return build(root)
}

/* The answer key for a composed prompt: what its own structure says should
   happen, step by step, so a model's behaviour has something to be read
   against rather than only the wording it was given. */
export function runComposition(ir, steps, options = {}) {
  return runLifecycle(lifecycleFromComposition(ir, options), steps, options)
}

/* How deep the running structure goes, counting the root as one. Reported, not
   limited, and carried beside the composed prompt so a study can record it as
   the measurement it is rather than recomputing it later. */
export function runDepth(root) {
  return 1 + Math.max(0, ...(root.children || []).map(runDepth))
}
export function containerCount(root) {
  return (root.children ? 1 : 0) + (root.children || []).reduce((total, child) => total + containerCount(child), 0)
}
