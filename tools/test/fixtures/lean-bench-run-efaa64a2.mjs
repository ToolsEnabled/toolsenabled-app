// The Lean Bench run of record from the .45 preparation (lane R2, 2026-09-10): frozen project
// efaa64a2..., executed once through the exported CLI with the pinned LEAN engine. Three trials:
// the starter's recorded trace canary (graded no-program under lean-python), the trusted generated
// reference program (correct) and a live Claude CLI reply (correct). Apparatus-development evidence
// only: not a counted study and not a model result; the journal says so in every event.
//
// The files under ./lean-bench-run-efaa64a2/ are byte-for-byte copies of
// evidence/manager-45-20260910/R2/run/project.json and R2/run/results/{attempts.jsonl, summary.json,
// native-verification.json, qualification.json}. The digests below are the copies' SHA-256; a copy
// that drifts refuses to load, so no test can quietly run against edited evidence. The files carry
// no secret, account name or home path (scanned before copying).
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

export const LEAN_BENCH_RUN_PROJECT_SHA256 = 'efaa64a29e87a38b48893fee77a06599382dafc1bb8a9ef0e21f5832ef0c1dc2'

export const LEAN_BENCH_RUN_DIGESTS = Object.freeze({
  'project.json': '86508a45d7afd046cd1b5188c6ac4cb38480133792c85645a051dc24650b6d03',
  'attempts.jsonl': '5603de5b419ea0613040a9922fc2907b7ac9c177a396a69204205dc592b7843b',
  'summary.json': '231c615c066c2769f14a562e4b9cc19f53052a1da4cae257f811d1d0414c2781',
  'native-verification.json': 'cb16979e165ccb837b6d5d5365d1ca5e55a08a1515a507f4e3651e5e765219e9',
  'qualification.json': '4aff9edd5ec131e4036b4e6427792bf815495a4cdfa21b2363f4200fe8692811',
})

export async function leanBenchRunFile(name) {
  const expected = LEAN_BENCH_RUN_DIGESTS[name]
  if (!expected) throw new Error(`${name} is not part of the retained Lean Bench run fixture.`)
  const bytes = await readFile(new URL('./lean-bench-run-efaa64a2/' + name, import.meta.url))
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== expected) throw new Error(`${name}: the fixture copy drifted from the retained run (sha256 ${digest}).`)
  return bytes.toString('utf8')
}

export async function leanBenchRun() {
  const [project, journal, summary, nativeVerification, qualification] = await Promise.all(
    ['project.json', 'attempts.jsonl', 'summary.json', 'native-verification.json', 'qualification.json'].map(leanBenchRunFile))
  return {
    project: JSON.parse(project),
    events: journal.trim().split('\n').map(line => JSON.parse(line)),
    summary: JSON.parse(summary),
    nativeVerification: JSON.parse(nativeVerification),
    qualification: JSON.parse(qualification),
  }
}
