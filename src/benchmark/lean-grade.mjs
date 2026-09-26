// LEAN execution adapter for model-written Python. This module owns each
// disposable container and grades engine order artifacts, never model logs.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, readdir, lstat } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { canonical, invariant, sha256 } from './prompts.mjs'
import { validateLean } from './lean.mjs'
import { decodeInformationResponse, gradeInterpretations, informationDisposition } from './information.mjs'
import { measuredPhase } from './observations.mjs'
import { pythonSource, sourceFailureClassification, nativeObservation, leanConfig, leanContainerArguments, leanContainerRecord } from './lean-observations.mjs'
import { validateTradingMarket } from './trading-market.mjs'
import { operationalCandidateFiles } from './trading-study.mjs'
export { pythonSource, normalizeOrderEvents, leanConfig } from './lean-observations.mjs'


function tool(command, args, { signal, children, input, timeoutMs = 120000 } = {}) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    children?.add(child)
    const stdout = [], stderr = []; let size = 0, failure
    const stop = () => { failure ||= signal?.aborted ? signal.reason : Object.assign(new Error('Execution tool exceeded its time budget.'), { code: 'TOOL_TIMEOUT' }); child.kill('SIGKILL') }
    signal?.addEventListener('abort', stop, { once: true }); if (signal?.aborted) stop()
    const timer = setTimeout(stop, timeoutMs)
    const capture = target => chunk => { size += chunk.length; if (size > 8 * 1024 * 1024) { failure = new Error('Execution tool output exceeds 8 MiB.'); stop() } else target.push(chunk) }
    child.stdout.on('data', capture(stdout)); child.stderr.on('data', capture(stderr))
    child.on('error', error => { failure = error }); child.stdin.on('error', error => { if (error.code !== 'EPIPE') failure = error })
    child.on('close', (code, killedBy) => {
      clearTimeout(timer); signal?.removeEventListener('abort', stop); children?.delete(child)
      const result = { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode: code, signal: killedBy }
      if (failure) { failure.evidence = result; reject(failure) } else done(result)
    })
    child.stdin.end(input)
  })
}
async function removeContainer(name, projectSha256) {
  try {
  const inspected = await tool('docker', ['inspect', '--type', 'container', '--format', '{{json .Config.Labels}}', name], { timeoutMs: 15000 })
  if (inspected.exitCode !== 0 && /No such (?:container|object)/i.test(inspected.stderr)) return
  if (inspected.exitCode !== 0 || JSON.parse(inspected.stdout)?.['research-benchmark.project'] !== projectSha256) throw Object.assign(new Error(`Could not verify ownership of LEAN container ${name}. Inspect it before recovery.`), { terminationConfirmed: false, evidence: inspected })
  const removed = await tool('docker', ['rm', '-f', name], { timeoutMs: 15000 })
  if (removed.exitCode !== 0 && !/No such container/i.test(removed.stderr)) throw Object.assign(new Error(`Could not confirm removal of owned LEAN container ${name}. Inspect it before recovery.`), { terminationConfirmed: false, evidence: removed })
  } catch (error) { error.terminationConfirmed = false; throw error }
}
async function removeOwnedContainers(names, projectSha256) {
  const outcomes = await Promise.allSettled(names.map(name => removeContainer(name, projectSha256)))
  const failure = outcomes.find(outcome => outcome.status === 'rejected')
  if (failure) throw failure.reason
}
export async function recoverLeanResources(output, projectSha256) {
  let entries
  try { entries = await readdir(resolve(output, 'artifacts'), { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') return; throw error }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const file = resolve(output, 'artifacts', entry.name, 'ownership.json')
    let record
    try { invariant((await lstat(file)).isFile(), 'Owned resource record is not a regular file.'); record = JSON.parse(await readFile(file, 'utf8')) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    invariant(record.projectSha256 === projectSha256 && /^research-lean-[a-f0-9-]{36}$/.test(record.container) && record.metadataContainer === record.container + '-metadata', 'The owned resource record has an invalid project binding.')
    await removeOwnedContainers([record.container, record.metadataContainer], projectSha256)
  }
}
async function nativeArtifacts(results, task, id) {
  const files = await readdir(results)
  const resultFile = `${id}.json`, eventsFile = `${id}-order-events.json`
  invariant(files.includes(resultFile), 'LEAN did not produce a native result artifact.')
  const readArtifact = async file => {
    const path = join(results, file), info = await lstat(path)
    invariant(info.isFile() && info.size <= 16 * 1024 * 1024, 'A native artifact is not a regular file within the 16 MiB limit.')
    return JSON.parse(await readFile(path, 'utf8'))
  }
  const result = await readArtifact(resultFile), hasEvents = files.includes(eventsFile)
  const events = hasEvents ? await readArtifact(eventsFile) : null
  return { trace: nativeObservation(result, events, task), files: [resultFile, ...(hasEvents ? [eventsFile] : [])] }
}

export async function gradeLean(project, task, output, { root, artifacts, trial, attempt, signal, children, measure } = {}) {
  if (task.information) {
    const decoded = decodeInformationResponse(task, output)
    if (decoded.behavior !== 'answer') return informationDisposition(decoded)
    output = decoded.answer
  }
  let code
  try { code = await measuredPhase(measure, 'program-extraction', () => pythonSource(output)) } catch (error) { return { passed: false, score: 0, classification: sourceFailureClassification(error), reason: error.message } }
  if (task.compiled.operational) validateTradingMarket(task.compiled.operational, task.input)
  else validateLean(task.compiled.semantic, task.input)
  const image = project.spec.environment.leanImage
  invariant(/@sha256:[a-f0-9]{64}$/.test(image), 'A pinned LEAN image digest is required.')
  const id = `${trial.id}-${attempt}`, directory = resolve(artifacts, id), algorithm = join(directory, 'algorithm'), data = join(directory, 'data'), results = join(directory, 'results')
  invariant(!/[",\r\n]/.test(directory), 'Use an execution output directory without commas, quotes or newlines for Docker mounts.')
  const name = 'research-lean-' + randomUUID(), metadataName = name + '-metadata'
  await measuredPhase(measure, 'native-preparation', async () => {
    for (const path of [algorithm, data, results]) await mkdir(path, { recursive: true })
    const sourceFiles = task.compiled.operational ? operationalCandidateFiles(task, code, { 'trading_broker.py': await readFile(resolve(root, 'trading_broker.py'), 'utf8') }) : { 'main.py': code + '\n' }
    for (const [file, source] of Object.entries(sourceFiles)) await writeFile(join(algorithm, file), source)
    await writeFile(join(directory, 'config.json'), JSON.stringify(leanConfig(id), null, 2) + '\n')
    const input = task.compiled.operational ? { bars: task.input.bars.map(bar => ({ ...bar, time: new Date(bar.time * 1000).toISOString() })) } : task.input
    const generated = await tool(process.platform === 'win32' ? 'python' : 'python3', [resolve(root, 'lean-data.py'), data], { signal, children, input: canonical(input) })
    invariant(generated.exitCode === 0, `Could not prepare LEAN data: ${generated.stderr}`)
    await writeFile(join(directory, 'ownership.json'), canonical({ image, projectSha256: project.sha256, container: name, metadataContainer: metadataName }) + '\n')
  })
  let execution, executionTimedOut = false
  try {
    await measuredPhase(measure, 'native-preparation', async () => {
      const created = await tool('docker', ['create', '--pull', 'never', '--name', metadataName, '--label', `research-benchmark.project=${project.sha256}`, '--network', 'none', '--entrypoint', '/bin/true', image], { signal, children })
      invariant(created.exitCode === 0, `The pinned LEAN image is unavailable. Pull the declared digest before running. ${created.stderr}`)
      for (const folder of ['market-hours', 'symbol-properties']) {
        const copied = await tool('docker', ['cp', `${metadataName}:/Lean/Data/${folder}`, data], { signal, children })
        invariant(copied.exitCode === 0, `Could not read pinned LEAN metadata: ${copied.stderr}`)
      }
    })
    const args = leanContainerArguments({ projectSha256: project.sha256, image, name, algorithm, data, results, config: join(directory, 'config.json') })
    try { execution = await measuredPhase(measure, 'native-execution', () => tool('docker', args, { signal, children, timeoutMs: project.spec.protocol.grading.executionTimeoutMs })) }
    catch (error) {
      if (error.evidence) await writeFile(join(directory, 'execution.json'), JSON.stringify(error.evidence, null, 2) + '\n')
      if (error.code !== 'TOOL_TIMEOUT' || signal?.aborted) throw error
      execution = error.evidence; executionTimedOut = true
    }
    await writeFile(join(directory, 'execution.json'), JSON.stringify(execution, null, 2) + '\n')
  } finally {
    await measuredPhase(measure, 'cleanup', () => removeOwnedContainers([name, metadataName], project.sha256))
  }
  // The grade records the arguments this runtime ran, with host paths as placeholders.
  const evidence = { directory: `artifacts/${id}`, image, candidateSha256: await sha256(code), execution, container: leanContainerRecord({ projectSha256: project.sha256, image }) }
  if (executionTimedOut) return { passed: false, score: 0, classification: 'execution-timeout', ...evidence }
  if ([125, 126, 127].includes(execution.exitCode)) throw Object.assign(new Error('The container execution infrastructure failed before a grade could be established.'), { evidence: execution })
  if (execution.exitCode !== 0) return { passed: false, score: 0, classification: 'execution-error', ...evidence }
  try {
    return await measuredPhase(measure, 'native-observation', async () => {
      const native = await nativeArtifacts(results, task, id)
      const passed = canonical(native.trace) === canonical(task.expected)
      await writeFile(join(directory, 'actual-trace.json'), JSON.stringify(native.trace, null, 2) + '\n')
      const grade = task.information ? gradeInterpretations(task, native.trace, 'json') : { passed, score: passed ? 1 : 0, classification: passed ? 'correct' : 'trace-mismatch' }
      return { ...grade, ...evidence, ...native }
    })
  } catch (error) { return { passed: false, score: 0, classification: 'invalid-engine-result', reason: error.message, ...evidence } }
}
