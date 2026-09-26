// Synthetic audit controls. These records never represent investigator approval.
import { developmentStarter, developmentDraft } from './research-benchmark-development.mjs'
import { bindRuntimeSources, freezeStudy } from '../../../src/benchmark/study.mjs'
import { runStudy } from '../../../src/benchmark/runner.mjs'
import { auditStudyFromReference, sealAuditReference } from '../../../src/benchmark/audit.mjs'

export async function auditFixture(sources) {
  const subject = developmentStarter()
  subject.name = 'Synthetic reference observations'
  subject.conditions = [
    { ...subject.conditions[0], id: 'faithful' },
    { ...subject.conditions[0], id: 'mutated', adapter: { kind: 'replay', responses: { 'addition-a': '6', 'addition-b': '12' } } },
    { ...subject.conditions[0], id: 'duplicate-faithful' },
  ]
  const source = await freezeStudy(await bindRuntimeSources(subject, sources)), result = await runStudy(source)
  const reference = await sealAuditReference(source, result.events, Object.fromEntries(Object.entries(sources).map(([file, value]) => [`runtime/${file}`, value])))
  const spec = developmentDraft(await auditStudyFromReference(reference))
  spec.requireReview = false
  spec.name = 'Synthetic judge audit'
  return { spec, reference, source, events: result.events }
}
