// Portable deterministic apparatus checks; this is not a personal review or a
// receipt for model collection or execution in the LEAN engine.
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { canonical, compilePrompt, invariant, sha256 } from './prompts.mjs'
import { interpretLean, leanCatalog, validateLean } from './lean.mjs'
import { gradeResponse } from './study.mjs'
import { qualificationFixtures } from './lean-cases.mjs'
import { operationalStudy } from './trading-study.mjs'
import { simulateTradingMarket, validateTradingMarket } from './trading-market.mjs'
import { qualifyRequirements, requirementInterpretation, requirementInterpreterRequest } from './requirements.mjs'
import { commandAdapter, confinedFile } from './cli.mjs'
export { requirementInterpretation } from './requirements.mjs'

function pythonReference(root, task, python, signal) {
  return new Promise((done, reject) => {
    signal.throwIfAborted()
    // Qualification reads the frozen apparatus; imported Python modules must
    // not leave bytecode writes beside those measured source files.
    const child = spawn(python, ['-B', resolve(root, task.compiled.operational ? 'trading_market.py' : 'lean-reference.py')], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout = [], stderr = []; let size = 0, failure
    const stop = () => { failure ||= signal.reason || new Error('Qualification cancelled.'); child.kill('SIGKILL') }
    signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop()
    const timer = setTimeout(() => { failure = new Error('Independent interpreter exceeded its 60-second budget.'); stop() }, 60000)
    const capture = target => bytes => { size += bytes.length; if (size > 32 * 1024 * 1024) { failure = new Error('Independent interpreter output exceeds 32 MiB.'); stop() } else target.push(bytes) }
    child.stdout.on('data', capture(stdout)); child.stderr.on('data', capture(stderr))
    child.on('error', error => { failure = error }); child.stdin.on('error', error => { if (error.code !== 'EPIPE') failure = error })
    child.on('close', code => {
      clearTimeout(timer); signal.removeEventListener('abort', stop)
      const raw = { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode: code }
      if (failure || code !== 0) { const error = failure || new Error('Independent interpreter failed.'); error.evidence = raw; reject(error); return }
      try { done({ result: JSON.parse(raw.stdout), process: raw }) } catch (error) { error.evidence = raw; reject(error) }
    })
    child.stdin.end(canonical(task.compiled.operational ? { ir: task.compiled.operational, input: task.input } : { semantic: task.compiled.semantic, input: task.input }) + '\n')
  })
}

export async function qualifyProject(root, project, { python = process.platform === 'win32' ? 'python' : 'python3', signal = new AbortController().signal } = {}) {
  const checks = [], moduleExecutions = [], modules = project.requirements?.interpreters
  const moduleReference = async (kind, task, target = null) => {
    signal.throwIfAborted()
    const binding = modules[kind], file = await confinedFile(root, binding.file), request = requirementInterpreterRequest(task, target)
    invariant(await sha256(await readFile(file)) === binding.sha256, 'Qualification interpreter source changed: ' + binding.file + '.')
    const controller = new AbortController(), cancel = () => controller.abort(signal.reason || new Error('Qualification cancelled.'))
    signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel()
    const timer = setTimeout(() => controller.abort(new Error('Interpreter module exceeded its 60-second budget.')), 60000)
    try {
      const response = await commandAdapter(root, { command: process.execPath, args: [resolve(root, 'module-host.mjs'), file, 'interpret'] }, request, controller.signal)
      moduleExecutions.push({ kind, binding, request, process: response.process })
      return response.output
    } catch (error) {
      moduleExecutions.push({ kind, binding, request, error: error.message || String(error), ...(error.evidence ? { process: error.evidence } : {}) })
      throw error
    } finally { clearTimeout(timer); signal.removeEventListener('abort', cancel) }
  }
  try {
  if (project.spec.domain === 'lean-bench' && !operationalStudy(project.spec)) for (const fixture of qualificationFixtures()) {
    const catalog = leanCatalog()
    if (fixture.reverseOrder) catalog.find(bundle => bundle.id === 'race').slotOrder = ['second', 'first']
    const compiled = await compilePrompt(catalog, fixture.root), task = { ...fixture, compiled }
    const javascript = interpretLean(compiled.semantic, fixture.input), independent = await pythonReference(root, task, python, signal)
    invariant(canonical(javascript) === canonical(independent.result), `${fixture.id}: qualification interpreters disagree.`)
    if (fixture.handTrace) invariant(canonical(javascript.trace) === canonical(fixture.handTrace), `${fixture.id}: the hand-authored trace does not match.`)
    for (const [field, key] of [['bars', 'bar'], ['quantities', 'quantity'], ['reasons', 'reason']]) if (fixture[field]) invariant(canonical(javascript.trace.map(fill => fill[key])) === canonical(fixture[field]), `${fixture.id}: the hand-authored ${field} do not match.`)
    if (fixture.id === 'depth-seven') invariant(javascript.trace.some(fill => fill.path.split('/').length >= 9), 'The deep mixed-tree control did not activate its deepest branch.')
    if (fixture.id === 'race-nested-owner') invariant(javascript.trace.every(fill => fill.path.includes('/strategy/first/')), 'Nested race ownership control failed.')
    if (fixture.id === 'reverse-race-order') invariant(javascript.trace.every(fill => fill.path.includes('/strategy/second/')), 'Declared sibling-order control failed.')
    checks.push({ fixtureId: fixture.id, passed: true, kind: 'apparatus-control', javascript, python: independent })
  }
  for (const task of project.tasks) {
    signal.throwIfAborted()
    const variants = [{ id: null, compiled: task.compiled, expected: task.expected }, ...(task.interpretations || [])]
    for (const variant of variants) {
      const identity = { taskId: task.id, ...(variant.id ? { readingId: variant.id } : {}) }
      if (project.spec.domain === 'lean-bench') {
        const evaluated = { ...task, compiled: variant.compiled, expected: variant.expected }
        const javascript = evaluated.compiled.operational ? simulateTradingMarket(evaluated.compiled.operational, task.input) : interpretLean(evaluated.compiled.semantic, task.input)
        const independent = await pythonReference(root, evaluated, python, signal)
        invariant(canonical(javascript) === canonical(independent.result), `${task.id}/${variant.id || 'baseline'}: the independent interpreters disagree.`)
        invariant(canonical(variant.expected) === canonical(evaluated.compiled.operational ? independent.result.observation : independent.result.trace), `${task.id}/${variant.id || 'baseline'}: the declared expected observation disagrees with independent execution.`)
        checks.push({ ...identity, passed: true, kind: 'independent-interpretation', expected: variant.expected, javascript, python: independent })
      } else if (modules) {
        if (task.information && !variant.id) continue
        const evaluated = { ...task, compiled: variant.compiled, root: variant.root || task.root, variables: { ...(task.variables || {}), ...(variant.variables || {}) }, expected: variant.expected }
        const reference = await moduleReference('reference', evaluated), independent = await moduleReference('independent', evaluated)
        invariant(reference && Object.hasOwn(reference, 'observation') && canonical(reference) === canonical(independent)
          && canonical(reference.observation) === canonical(variant.expected), 'The generic interpreter counterparts disagree or differ from the frozen expected observation.')
        checks.push({ ...identity, passed: true, kind: 'independent-module-interpretation', reference, independent })
      } else if (project.spec.protocol.grading.kind === 'judge-audit') {
        const known = task.audit.referenceVerdict !== null, grade = gradeResponse(project, task, { verdict: task.audit.referenceVerdict || 'abstain' })
        invariant(known ? grade.passed === true && grade.score === 1 : grade.passed === null && grade.score === null, 'The audit grader disagrees with its frozen reference eligibility.')
        checks.push({ ...identity, passed: true, kind: 'judge-reference-binding', referenceEligible: known, referenceBasis: task.audit.referenceBasis, grade,
          scope: 'Reference bundle, source journal and native artifacts (when present) were rechecked; no new judge or native execution is inferred.' })
      } else if (['exact', 'json'].includes(project.spec.protocol.grading.kind)) {
        if (task.information && !variant.id) continue // The latent baseline is not an arbitrary grading oracle.
        let output = project.spec.protocol.grading.kind === 'json' ? canonical(variant.expected) : variant.expected
        if (task.information?.responseMode === 'tagged-json') output = { kind: 'answer', answer: variant.expected }
        const correct = gradeResponse(project, task, output)
        invariant(correct.passed && correct.score === 1, `${task.id}: the declared answer fails its own grading rule.`)
        checks.push({ ...identity, passed: true, kind: task.information ? 'declared-interpretation' : 'declared-answer', grade: correct })
      } else checks.push({ ...identity, passed: null, kind: 'custom-grader', reason: 'Supply independent fixtures for this custom grading rule.' })
    }
  }
  const requirements = project.requirements ? await qualifyRequirements(project.requirements, project.spec.domain === 'lean-bench' ? {
    signal,
    validInput: (task, input) => { try { task.compiled.operational ? validateTradingMarket(task.compiled.operational, input) : validateLean(task.compiled.semantic, input); return true } catch { return false } },
    interpret: async (task, target) => requirementInterpretation(task, target, task.compiled.operational ? simulateTradingMarket(task.compiled.operational, task.input) : interpretLean(task.compiled.semantic, task.input)),
    independent: async (task, target) => requirementInterpretation(task, target, (await pythonReference(root, task, python, signal)).result),
  } : modules ? { signal, interpret: (task, target) => moduleReference('reference', task, target), independent: (task, target) => moduleReference('independent', task, target) } : { signal }) : null
  return { format: 'research-benchmark-qualification', version: 1, projectSha256: project.sha256, runtimeSources: project.spec.runtimeSources,
    ...(requirements ? { requirements } : {}), ...(modules ? { moduleExecutions } : {}),
    environment: { node: process.version, platform: process.platform, architecture: process.arch, python }, checks,
    scope: 'Local compiler/interpreter and declared-answer checks. This record does not execute a model or the LEAN engine, approve bundles, or certify a counted study.' }
  } catch (error) {
    error.partialQualification = { projectSha256: project.sha256, runtimeSources: project.spec.runtimeSources, checks, moduleExecutions,
      status: 'interrupted-or-failed', scope: 'Partial diagnostic execution only; no successful qualification proof.' }
    throw error
  }
}
