import { invariant, object } from './benchmark/prompts.mjs'
import { resetRecordedResponses } from './research-recorded-responses.mjs'

const identity = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value)
const finiteJson = (_key, value) => {
  invariant(typeof value !== 'number' || Number.isFinite(value), 'Source drafts require finite JSON numbers; no value was replaced with null. Your current fields are preserved.')
  return value
}

// A deliberate authoring derivative, never a substitute for live source tasks
// during compilation. No bindings, expected answers or execution proofs refresh.
export function createCompositionFamilySourceDraft({ spec, attachments = {}, familyFields, singleFields = '' }) {
  invariant(typeof familyFields === 'string' && typeof singleFields === 'string', 'Retain the family workspace and local fields as their original text.')
  let workspace
  try { workspace = JSON.parse(familyFields) } catch { throw new Error('The retained family workspace must be valid JSON. Its text is preserved.') }
  invariant(object(workspace) && workspace.version === 1 && Array.isArray(workspace.families)
    && workspace.families.length > 0 && workspace.families.length <= 512, 'Retain 1–512 source families in a version 1 workspace.')
  const next = JSON.parse(JSON.stringify(spec, finiteJson)), files = JSON.parse(JSON.stringify(attachments, finiteJson))
  invariant(object(next) && !next.auditPlan && !next.experimentTemplate, 'Use the dedicated audit or resource template to edit its source design.')
  const sources = new Set(), originalFamilies = new Set(), generatedFamilies = new Set()
  next.tasks = workspace.families.map(entry => {
    const task = entry?.sourceTask, fields = entry?.fields, familyId = task?.familyId || task?.id
    invariant(object(task) && object(task.root) && identity(task.id) && object(fields) && fields.taskId === task.id,
      'Each retained family needs an editable source task and matching occurrence fields.')
    invariant(!task.information && !task.audit && !task.resource, 'Use the dedicated information, audit or resource template to edit these source tasks.')
    invariant(identity(familyId) && identity(fields.familyId), 'Retained source and generated families need valid identifiers.')
    invariant(!sources.has(task.id) && !originalFamilies.has(familyId) && !generatedFamilies.has(fields.familyId),
      'Retain distinct source tasks, original families and generated families; source seeds do not become independent units by copying them.')
    sources.add(task.id); originalFamilies.add(familyId); generatedFamilies.add(fields.familyId)
    return task
  })
  if (next.corpusPlan !== undefined) {
    invariant(next.corpusHistory === undefined || Array.isArray(next.corpusHistory), 'The existing corpus history must be an array.')
    next.corpusHistory = [...(next.corpusHistory || []), { kind: 'detached-recipe', recipe: next.corpusPlan }]
    delete next.corpusPlan
  }
  invariant(Array.isArray(next.conditions), 'Retain the applied condition configurations before exporting family sources.')
  next.conditions = resetRecordedResponses(next.conditions)
  // Rebuild all task-specific editors on ordinary import. Generated task buffers
  // must never be reapplied over the archived source roster at the same index.
  const draft = { version: 1, spec: next, attachments: files, pending: ['compositionFamilies'], taskIndex: 0, bundleIndex: 0,
    editors: { 'data-bench-composition-family-fields': familyFields, 'data-bench-composition-fields': singleFields } }
  invariant(new TextEncoder().encode(JSON.stringify(draft, finiteJson, 2)).byteLength <= 128 * 1024 * 1024,
    'The editable source draft exceeds the 128 MiB import limit. No file was exported; the current draft is unchanged.')
  return draft
}
