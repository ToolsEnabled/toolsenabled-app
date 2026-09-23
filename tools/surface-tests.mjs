#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { parseOptions } from './lib/surface-tests/options.mjs'
import { buildPlan, batches, overall } from './lib/surface-tests/plan.mjs'
import { LIMITATIONS } from './lib/surface-tests/catalog.mjs'
import { pathCatalog, pathsMarkdown } from './lib/surface-tests/path-catalog.mjs'
import { markdown, resultStatus } from './lib/surface-tests/results.mjs'
import { runMemoryFixtures } from './lib/surface-tests/memory.mjs'
import { sourceIdentity, artifactIdentity, hostedIdentity } from './lib/surface-tests/identity.mjs'
import { ordinaryPath } from './lib/development-session.mjs'
const require = createRequire(import.meta.url)
const { sterileProfileDirectories, prepareSterileProfile, sterileLaunchEnvironment } = require('./lib/sterile-launch.cjs')
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const json = value => JSON.stringify(value, null, 2) + '\n'
const help = `Usage: node tools/surface-tests.mjs paths|list|run [options]
  paths                        Print ordered user actions and expected outcomes; no execution.
  --engine ABS --out FRESH_ABS   Required for run; preserves logs and profiles.
  --profile smoke|full          Curated suite breadth, not certification.
  --surface source,browser,mobile,hosted,packaged,phone (or all)
  --only login,fra-identity,...  Restricts source groups; list shows names.
  --jobs 1|2 --budget-ms N --timeout-ms N
  --release ABS --expect-app SHA40 --expect-engine SHA40
  --origin https://HOST --mount /app/ (hosted; cannot mix with release)
  --playwright-root ABS --browsers-path ABS (installed dependencies only)
  --fixture-cleanup refuse|approved (default refuse; approval must exist first)
Exit: 0 all selected checks passed; 1 failures; 2 blocked/not-run/prerequisites.
Never adopts an existing app window/profile or starts paid providers.\n`

export async function main(argv = process.argv.slice(2)) {
  const o = parseOptions(argv)
  if (o.command === 'help') { process.stdout.write(help); return 0 }
  if (o.command === 'paths') { process.stdout.write(pathsMarkdown(pathCatalog(o.surfaces))); return 0 }
  const plan = buildPlan(o, appRoot)
  if (o.command === 'list') { process.stdout.write(json({ profile: o.profile, plan, userPaths: pathCatalog(o.surfaces), limitations: LIMITATIONS })); return 0 }
  ordinaryPath(o.engine); ordinaryPath(o.out, { missing: true })
  for (const root of [appRoot, o.engine]) {
    const relative = path.relative(root, o.out)
    if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw Error('Output must be outside both source repositories')
  }
  fs.mkdirSync(o.out, { mode: 0o700 }) // exclusive, never reuses old evidence
  const started = Date.now(), report = { schemaVersion: 1, startedAt: new Date(started).toISOString(), platform: process.platform,
    node: process.version, profile: o.profile, surfaces: o.surfaces, sourceSelection: o.only, limitations: LIMITATIONS,
    results: plan.map(job => ({ id: job.id, surface: job.surface, status: 'NOT_RUN', reason: 'Not executed yet' })), plan }
  let stopped = false
  const admission = () => {
    const remainingMs = o.budgetMs - (Date.now() - started)
    return { remainingMs, reason: stopped ? 'Previous process cleanup was unconfirmed'
      : remainingMs <= 0 ? 'Run time budget exhausted' : null }
  }
  const save = () => { report.elapsedMs = Date.now() - started; report.status = overall(report.results)
    fs.writeFileSync(path.join(o.out, 'report.json'), json(report)); fs.writeFileSync(path.join(o.out, 'REPORT.md'), markdown(report)) }
  const expected = { app: o['expect-app'], engine: o['expect-engine'] }
  save()
  try {
    report.sources = { app: sourceIdentity(appRoot), engine: sourceIdentity(o.engine) }
    const { runIsolatedChild } = require(path.join(o.engine, 'tests/lib/isolated-child.js'))
    const { configure } = require(path.join(o.engine, 'tests/lib/isolated-environment.js'))
    const { validateCompletion } = require(path.join(o.engine, 'tools/lib/test-completion.js'))
    for (const batch of batches(plan, o.jobs)) {
      const rows = await Promise.all(batch.map(async job => {
        const at = Date.now(), base = { id: job.id, surface: job.surface, args: job.args, cwd: job.root }
        if (job.blocked) return { ...base, status: 'BLOCKED', reason: job.blocked }
        let gate = admission()
        if (gate.reason) return { ...base, status: 'NOT_RUN', reason: gate.reason }
        let launched = false
        try {
          let identity
          if (job.surface !== 'source') identity = job.id === 'hosted'
            ? await hostedIdentity(o.origin, o.mount, expected) : artifactIdentity(o.release, expected)
          gate = admission() // Identity may have awaited beyond the deadline.
          if (gate.reason) return { ...base, status: 'NOT_RUN', reason: gate.reason }
          const root = path.join(o.out, job.id + '-profile')
          const safe = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|OS|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|DISPLAY|XAUTHORITY|LANG|LC_ALL)$/i.test(key)))
          const env = sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(root)), safe)
          configure(path.join(root, 'state'), env)
          Object.assign(env, { MC_CANONICAL_ROOT: o.engine, TOOLSENABLED_SOURCE: o.engine, TOOLSENABLED_TEST_STRICT: '1',
            TOOLSENABLED_TEST_RETAIN_FIXTURES: '1', TOOLSENABLED_RETAIN_LIFECYCLE_FIXTURES: '1', MC_SMOKE_HEADLESS: '1' })
          if (o['playwright-root']) env.TESTKIT_PLAYWRIGHT_ROOT = o['playwright-root']
          if (o['browsers-path']) env.PLAYWRIGHT_BROWSERS_PATH = o['browsers-path']
          if (job.id === 'hosted') Object.assign(env, { APP_ORIGIN: o.origin, APP_PATH: o.mount, PHONE_GATE_QA_REPORT: job.summary })
          gate = admission() // Profile/preflight work must not admit a late child.
          if (gate.reason) return { ...base, status: 'NOT_RUN', reason: gate.reason }
          launched = true
          const timeout = Math.min(o.timeoutMs, gate.remainingMs)
          let result
          if (job.strategy === 'inert-files') {
            const memory = await runMemoryFixtures(job, { runChild: runIsolatedChild, validateCompletion, executable: process.execPath, env, timeout })
            result = memory.result; base.commands = memory.commands
            fs.writeFileSync(job.summary, json(memory.summary))
          } else result = await runIsolatedChild(process.execPath, job.args, { cwd: job.root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, maxBuffer: 8 * 1024 * 1024 })
          fs.writeFileSync(path.join(o.out, job.id + '.stdout.log'), result.stdout || '')
          fs.writeFileSync(path.join(o.out, job.id + '.stderr.log'), result.stderr || '')
          let evidence
          if (job.kind === 'engine' || (job.kind === 'driver' && job.id !== 'packaged')) {
            try { evidence = JSON.parse(fs.readFileSync(job.summary, 'utf8')) } catch { /* missing evidence is a failure */ }
          }
          const verdict = resultStatus(job, result, evidence, validateCompletion)
          if (verdict.stop) stopped = true
          if (identity?.assertUnchanged) identity.assertUnchanged()
          if (job.id === 'hosted' && JSON.stringify(identity) !== JSON.stringify(await hostedIdentity(o.origin, o.mount, expected))) throw Error('Hosted build changed during checks')
          return { ...base, ...verdict, identity, elapsedMs: Date.now() - at, exitCode: result.status, cleanupConfirmed: result.cleanupConfirmed }
        } catch (error) { if (launched) stopped = true; return { ...base, status: error.code === 'ENOENT' && !launched ? 'BLOCKED' : 'FAIL', reason: error.code || error.message, elapsedMs: Date.now() - at } }
      }))
      report.results = report.results.map(row => rows.find(next => next.id === row.id) || row); save()
    }
    report.sourcesAfter = { app: sourceIdentity(appRoot), engine: sourceIdentity(o.engine) }
    if (JSON.stringify(report.sourcesAfter) !== JSON.stringify(report.sources)) report.results.push({ id: 'source-identity', status: 'FAIL', reason: 'Source changed during this run; result cannot bind a stable revision' })
  } catch (error) { report.results.push({ id: 'prerequisites', status: 'BLOCKED', reason: error.code || error.message }) }
  finally { save() }
  process.stdout.write(json({ status: report.status, report: path.join(o.out, 'REPORT.md'), selections: report.results.length }))
  return report.status === 'PASS' ? 0 : report.status === 'FAIL' ? 1 : 2
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code }, error => { console.error(error.message); process.exitCode = 2 })
}
