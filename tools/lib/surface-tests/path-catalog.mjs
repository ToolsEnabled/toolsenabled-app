import { BROWSER_PATHS } from './journeys.mjs'
import { MANUAL_PATHS } from './manual-paths.mjs'

const automated = p => ({ ...p, execution: 'automated browser action', evidence: 'scripted browser/emulation observation' })
const manualEvidence = p => p.evidence || (
  p.surfaces.includes('phone') && p.surfaces.includes('packaged')
    ? 'manual physical-Safari + desktop observation'
    : p.surfaces.includes('phone')
      ? 'manual physical-Safari observation'
      : p.surfaces.includes('hosted') && p.surfaces.includes('packaged')
        ? 'manual hosted + desktop observation'
        : p.surfaces.includes('hosted')
          ? 'manual hosted observation'
          : 'manual desktop/native observation'
)
const manual = p => ({ ...p, execution: 'manual acceptance; not executed by surface runner', evidence: manualEvidence(p) })

export function pathCatalog(surfaces) {
  const wanted = surfaces?.filter(s => s !== 'source') || []
  return [...BROWSER_PATHS.map(automated), ...MANUAL_PATHS.map(manual)]
    .filter(p => !wanted.length || p.surfaces.some(s => wanted.includes(s)))
    .map(p => ({ ...p, status: 'NOT_RUN' }))
}
export function pathsMarkdown(paths) {
  const clean = text => String(text).replace(/[|\r\n]/g, ' ')
  return '# User paths\n\nPlan only. No action or browser has been started.\n' +
    paths.map(p => '\n## ' + p.id + ': ' + p.title + '\n\n' +
      p.execution + '. Evidence: ' + p.evidence + '. Surfaces: ' + p.surfaces.join(', ') + '.\n\n' +
      p.scope + '\n\nPrerequisites: ' + p.prerequisites.join('; ') + '.\n\n' +
      '| Step | User action | Expected result |\n| --- | --- | --- |\n' +
      p.steps.map((s, i) => '| ' + (i + 1) + '. ' + clean(s.id) + ' | ' + clean(s.action) + ' | ' + clean(s.expected) + ' |').join('\n') + '\n').join('')
}
