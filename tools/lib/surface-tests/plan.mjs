import path from 'node:path'
import { selectGroups } from './catalog.mjs'
import { retainedAppSelection } from './fixture-policy.mjs'
import { browserPaths, browserCases } from './journeys.mjs'

// Planning is pure: no launcher, server, account, browser or profile is touched.
export function buildPlan(o, appRoot) {
  const jobs = []
  if (o.surfaces.includes('source')) for (const group of selectGroups(o.profile, o.only)) {
    const root = group.repo === 'app' ? appRoot : o.engine
    const summary = path.join(o.out || '<output>', group.id + '-engine.json')
    const memory = o.profile === 'smoke' && ['fra-identity', 'fra-relay', 'fra-authority'].includes(group.id)
    const retained = retainedAppSelection(group.repo, group.files)
    jobs.push({ id: group.id, surface: 'source', features: group.features, root,
      serial: group.repo === 'engine' || group.id === 'packaging', kind: group.repo === 'engine' ? 'engine' : 'tap',
      files: group.files, summary, fixtureCleanup: !memory && !retained, fixturePolicy: retained ? 'retained-source-profile' : memory ? 'in-memory-engine' : 'existing-suite-cleanup', strategy: memory ? 'inert-files' : 'existing-suite',
      args: memory ? [] : group.repo === 'engine'
        ? ['tests/run-isolated.js', '--summary', summary, '--timeout-ms', String(o.timeoutMs), ...group.files]
        : ['--test', '--import=./tools/test/lib/isolate-native-state-root.mjs', '--test-reporter=tap', '--test-concurrency=1', ...group.files] })
  }
  for (const surface of o.surfaces.filter(s => s !== 'source')) {
    const job = { id: surface, surface, root: appRoot, serial: true, fixtureCleanup: true,
      kind: 'driver', summary: path.join(o.out || '<output>', surface + '-driver.json') }
    if (['browser', 'mobile'].includes(surface)) {
      job.journeys = browserPaths(surface)
      job.caseLabels = browserCases(surface, o.profile).map(cell => cell.label)
    }
    if (surface === 'phone') {
      jobs.push({ ...job, blocked: 'Physical phone/user-input proof requires a connected device and explicitly bound inspector session. No device is adopted automatically.' }); continue
    }
    if (!o['expect-app'] || !o['expect-engine']) job.blocked = 'Both full expected source refs are required; no latest/old-runtime fallback.'
    if (surface === 'hosted') {
      if (!o.origin) job.blocked = 'Hosted needs an explicit origin; a desktop artifact is not a website.'
      job.args = ['tools/phone-signin-gate-qa.mjs']
    } else {
      if (!o.release) job.blocked = 'Select a qualified unpacked --release explicitly.'
      job.args = surface === 'packaged'
        ? ['tools/packaged-qa-suite.mjs', '--release', o.release, '--only', o.profile === 'full' ? 'home-screen-qa,page2-qa' : 'home-screen-qa', '--logs', path.join(o.out || '<output>', 'packaged-logs')]
        : ['tools/surface-browser.mjs', '--release', o.release, '--out', job.summary, '--matrix', surface, '--profile', o.profile]
    }
    if (['browser', 'mobile', 'hosted'].includes(surface) && !o['playwright-root']) job.blocked = 'Select an installed --playwright-root; dependencies are never downloaded.'
    jobs.push(job)
  }
  return jobs.map(job => ({ ...job, blocked: job.blocked || (job.fixtureCleanup && o['fixture-cleanup'] !== 'approved'
    ? 'Existing suites/browser profiles can delete their own fixtures. Obtain the required cleanup approval before selecting --fixture-cleanup approved.' : undefined) }))
}

export function batches(plan, jobs = 1) {
  const result = []; let batch = []
  const flush = () => { if (batch.length) result.push(batch); batch = [] }
  for (const job of plan) {
    if (job.serial) { flush(); result.push([job]); continue }
    batch.push(job); if (batch.length >= jobs) flush()
  }
  flush(); return result
}

export function overall(rows) {
  if (!rows.length) return 'BLOCKED'
  if (rows.some(row => row.status === 'FAIL')) return 'FAIL'
  return rows.every(row => row.status === 'PASS') ? 'PASS' : 'BLOCKED'
}
