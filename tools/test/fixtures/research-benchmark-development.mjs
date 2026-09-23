// These fixtures exercise unfinished apparatus (transport, graders, recovery,
// accounting and estimators). Their outputs are explicitly development evidence,
// never an admitted scientific experiment or a qualified arbitrary answer key.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { genericStarter, newExperimentDraft } from '../../../src/benchmark/starters.mjs'
import { RUNTIME_FILES } from '../../../src/benchmark/study.mjs'

export function developmentDraft(source) {
  const spec = newExperimentDraft(source, { purpose: 'apparatus-development' })
  spec.analysisPlan.cohort = 'qualification'
  spec.runtimeSources = Object.fromEntries(RUNTIME_FILES.map(file => [file,
    createHash('sha256').update(readFileSync(new URL('../../../src/benchmark/' + file, import.meta.url))).digest('hex')]))
  return spec
}

export function developmentStarter() { return developmentDraft(genericStarter()) }
