// Observable distributions for finite interpretation sets. Equivalent readings
// receive one observation; unresolved conventions are never divided by fiat.
import { canonical, invariant } from './prompts.mjs'

export const CONVENTIONS_VERSION = 1
const ratio = (n, d) => d ? n / d : null

export function interpretationObservation(task, completion) {
  if (!task.information) return null
  const grade = completion?.grade, matchingReadings = grade?.matchingReadings || []
  invariant(Array.isArray(matchingReadings) && new Set(matchingReadings).size === matchingReadings.length, 'Interpretation observations need distinct reading identifiers.')
  const classes = task.informationPacket.observableClasses
  const observed = classes.find(group => canonical([...group.readings].sort()) === canonical([...matchingReadings].sort()))
  invariant(!matchingReadings.length || observed, 'A graded observation must retain every reading in its complete observable class.')
  invariant(!grade?.passed || observed, 'An admissible grade needs a frozen observable class.')
  invariant(!observed || grade?.passed === true, 'A matched observable class cannot be recorded as outside the declared set.')
  const assignments = {}
  const axes = [...new Set(task.interpretations.flatMap(reading => Object.keys(reading.conventions || {})))].sort()
  for (const axis of axes) {
    const values = matchingReadings.map(id => task.interpretations.find(reading => reading.id === id)?.conventions?.[axis])
    const unique = new Map(values.filter(value => value !== undefined).map(value => [canonical(value), value]))
    assignments[axis] = values.length && values.every(value => value !== undefined) && unique.size === 1
      ? { kind: 'resolved', value: [...unique.values()][0] } : { kind: 'unresolved' }
  }
  return { scope: 'declared-set', behavior: grade ? grade.behavior || 'answer' : null,
    matchingReadings, observableSha256: observed?.observableSha256 || null, conventions: assignments,
    candidateReadings: task.informationPacket.selection.candidates.length, admissibleReadings: task.interpretations.length,
    observableClasses: classes.length, withheldRequirements: task.information.withheldPaths.length }
}

export function conventionDistributions(project, rows) {
  const distributions = []
  for (const task of project.tasks.filter(task => task.information)) {
    const selected = rows.filter(row => row.taskId === task.id), packet = task.informationPacket
    const axes = [...new Set(task.interpretations.flatMap(reading => Object.keys(reading.conventions || {})))].sort()
    const support = packet.observableClasses.map(group => ({ kind: 'observable', observableSha256: group.observableSha256, readings: group.readings }))
    const dimensions = [{ dimension: 'observable', support, classify: row => row.information.observableSha256
      ? support.find(bin => bin.observableSha256 === row.information.observableSha256) : { kind: 'disposition', disposition: row.disposition } },
    ...axes.map(axis => ({ dimension: `convention:${axis}`, support: [...new Map(task.interpretations.filter(reading => Object.hasOwn(reading.conventions || {}, axis)).map(reading => {
      const value = reading.conventions[axis]; return [canonical(value), { kind: 'resolved', value }]
    })).values(), { kind: 'unresolved' }], classify: row => row.information.observableSha256
      ? row.information.conventions[axis] : { kind: 'disposition', disposition: row.disposition } }))]
    for (const { dimension, support: declared, classify } of dimensions) {
      const bins = new Map(declared.map(bin => [canonical(bin), bin]))
      for (const row of selected) { const bin = classify(row); bins.set(canonical(bin), bin) }
      const ordered = [...bins.entries()].sort(([a], [b]) => a.localeCompare(b))
      for (const condition of project.spec.conditions) {
        const subset = selected.filter(row => row.conditionId === condition.id), completed = subset.filter(row => row.status === 'completed').length
        const counts = new Map()
        for (const row of subset) { const key = canonical(classify(row)); const count = counts.get(key) || { scheduled: 0, completed: 0 }; count.scheduled++; if (row.status === 'completed') count.completed++; counts.set(key, count) }
        distributions.push({ taskId: task.id, familyId: task.familyId, factors: task.factors || {}, split: task.split, condition: condition.id, dimension,
          scheduled: subset.length, completed, bins: ordered.map(([key, bin]) => ({ ...bin, count: counts.get(key)?.scheduled || 0, completedCount: counts.get(key)?.completed || 0,
            scheduledRate: ratio(counts.get(key)?.scheduled || 0, subset.length), completedRate: ratio(counts.get(key)?.completed || 0, completed) })) })
      }
    }
  }
  return { version: CONVENTIONS_VERSION, scope: 'declared-set', distributions,
    limitations: distributions.length ? [
      'Distributions describe agreement with declared readings on the frozen inputs. They do not identify a system’s internal reasoning or establish an exhaustive set of meanings.',
      'Readings with identical expected observations occupy one observable class. A convention is resolved only when every matching reading assigns the same value; other admissible observations remain unresolved.',
      'Zero counts retain frozen observable and convention categories. Clarification, refusal, malformed responses and collection failures remain distinct, with scheduled and completed denominators.',
    ] : [] }
}
