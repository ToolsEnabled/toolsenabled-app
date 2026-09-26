import { invariant } from './benchmark/prompts.mjs'

// The compiler already knows which layer contributed which characters:
// compilePrompt returns a source map beside the prompt text, and the venue
// report renders it as a "Layer map" table (report.mjs item 4). The Research
// page computed the same map and discarded it, so a person inspecting a task in
// the page could read the compiled prompt but could not see which bundle in the
// composition tree produced which span of it -- which is most of what reading a
// composed prompt is for.
//
// These rows are R1's report rows, built here once so the page and the report
// agree by construction instead of by two hand-written renderers drifting
// apart. Anything that wants the same markers elsewhere -- a per-attempt prompt
// in the evidence view, for instance -- should call this rather than write a
// second one.
export const LAYER_MAP_PREVIEW_ROWS = 60
export const LAYER_MAP_COLUMNS = ['Start', 'End', 'Node path', 'Bundle', 'Requirement']

export function layerMap(taskId, compiled, { limit = LAYER_MAP_PREVIEW_ROWS } = {}) {
  invariant(typeof taskId === 'string' && taskId.trim(), 'A layer map needs the id of the task it describes.')
  invariant(compiled && Array.isArray(compiled.sourceMap),
    'A layer map needs a compiled prompt carrying its source map.')
  // The unit is part of the reading: a range is in UTF-16 code units, so a
  // character outside the BMP occupies two of them. Never silently assume it.
  const unit = compiled.sourceMapUnit || 'UTF-16 code units'
  const total = compiled.sourceMap.length
  const rows = compiled.sourceMap.slice(0, Math.max(0, limit)).map(range =>
    [String(range.start), String(range.end), range.path, range.bundleId ?? 'runtime appendix', range.requirementId])
  return {
    id: 'source-map-' + taskId,
    columns: LAYER_MAP_COLUMNS,
    rows,
    shown: rows.length,
    total,
    unit,
    // Absent fields print as declared absent, never guessed.
    caption: `Layer map for ${taskId}, in ${unit}. Prompt SHA-256 ${compiled.promptSha256 || 'Not declared'}.`,
    more: rows.length < total ? `Showing ${rows.length} of ${total} ranges.` : '',
  }
}
