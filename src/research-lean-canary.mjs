import { canonical, invariant } from './benchmark/prompts.mjs'

// The Lean Bench starter ships one recorded canary, and it is written for the
// starter's own grader: under `json` the recorded response is the task's
// expected order trace, which is exactly what that grader compares. Under
// `lean-python` the same slot is graded by executing returned Python in the
// pinned engine, so a trace can only ever record no-program. Readiness refuses
// it before an engine run is paid for (`replay-response-not-a-program` in
// readiness.mjs), which leaves a starter that cannot enter the one grader Lean
// Bench exists for. Changing the grader therefore has to move the shipped
// canary into the form that grader reads.
//
// Only a response that still IS the shipped canary is moved: on the JSON side
// that means canonically equal to the task's own expected trace, and on the
// Python side equal to the program generated from that same frozen semantic
// tree. Anything an investigator recorded is left exactly as they recorded it,
// and readiness keeps explaining the mismatch in its own words.
//
// A generation failure is not swallowed. The only task this reaches is one
// whose recorded response is still the shipped trace canary; if its program
// cannot be rendered, the study cannot run under lean-python at all, and
// saying so while the protocol is applied is better than leaving a response
// that readiness will refuse later.
export async function alignLeanCanaryResponses(spec, { grading, previousGrading, program }) {
  invariant(spec && Array.isArray(spec.conditions) && Array.isArray(spec.tasks),
    'Canary alignment needs a draft with tasks and conditions.')
  invariant(typeof program === 'function', 'Canary alignment needs a program generator.')
  const direction = grading === 'lean-python' ? 'program'
    : previousGrading === 'lean-python' && grading === 'json' ? 'trace' : null
  if (spec.domain !== 'lean-bench' || !direction || grading === previousGrading) return { spec, moved: [] }
  const moved = [], conditions = structuredClone(spec.conditions)
  for (const condition of conditions) {
    const responses = condition?.adapter?.kind === 'replay' ? condition.adapter.responses : null
    if (!responses || typeof responses !== 'object') continue
    for (const task of spec.tasks) {
      if (!Object.hasOwn(responses, task.id) || task.expected === null || task.expected === undefined) continue
      const current = responses[task.id]
      if (direction === 'program') {
        // A string is already a program, or already something the investigator
        // typed; either way it is not the shipped trace canary.
        if (typeof current === 'string' || canonical(current) !== canonical(task.expected)) continue
        responses[task.id] = await program(task)
      } else {
        if (typeof current !== 'string' || current !== await program(task)) continue
        responses[task.id] = structuredClone(task.expected)
      }
      moved.push({ condition: condition.id, task: task.id, to: direction })
    }
  }
  return { spec: moved.length ? { ...spec, conditions } : spec, moved }
}

// One sentence for the page's status line, in the investigator's terms.
export function leanCanaryNote(moved) {
  if (!Array.isArray(moved) || !moved.length) return ''
  const tasks = [...new Set(moved.map(row => row.task))].join(', ')
  return moved[0].to === 'program'
    ? ` The starter's recorded canary for ${tasks} now carries the generated reference program this grader executes, instead of the order trace the JSON grader compared.`
    : ` The starter's recorded canary for ${tasks} carries its expected order trace again, which is what the JSON grader compares.`
}
