#!/usr/bin/env node
// Self-contained Node entry point. No ToolsEnabled packages or services.
import { readFile, writeFile, mkdir, open, realpath, lstat, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve, dirname, parse as pathParts, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { canonical, invariant, sha256 } from './prompts.mjs'
import { runtimeFilesFor, safePath, analyze, verifyProject, gradeResponse, templateCitationFiles } from './study.mjs'
import { researchReportFiles } from './report.mjs'
import { runStudy, replayAdapter, validateJournal, verifyResourceJournal, customGradeResult, recordedCustomGrade } from './runner.mjs'
import { qualifyProject } from './qualify.mjs'
import { leanProjectFiles } from './lean-codegen.mjs'
import { gradeLean, recoverLeanResources } from './lean-grade.mjs'
import { auditProjectFiles, auditReferencePaths, sealAuditReference, NATIVE_EVIDENCE_LIMITS, nativeEvidencePaths, verifyNativeJournalEvidence } from './audit.mjs'
import { measuredPhase, observationProjectFiles } from './observations.mjs'
import { compositionProjectFiles } from './composition.mjs'
import { operationalStudy } from './trading-study.mjs'
import { requirementProjectFiles, requirementReportFiles, selectedInputGate, verifyQualificationJournal } from './requirements.mjs'
import { collectionRequest, workflowProjectFiles } from './workflow.mjs'
import { corpusProjectFiles } from './corpus.mjs'
import { analysisProjectFiles, designProjectFiles } from './analysis.mjs'
import { templateProjectFiles } from './templates.mjs'
import { readinessProjectFiles, evaluateReadiness } from './readiness.mjs'

const MAX_OUTPUT = 8 * 1024 * 1024
export async function confinedFile(root, file) {
  invariant(safePath(file), `Invalid project path: ${file}.`)
  const base = await realpath(root), full = await realpath(resolve(base, file))
  invariant(full.startsWith(base + sep), `Project file leaves the project directory: ${file}.`)
  invariant((await lstat(full)).isFile(), `${file} is not a regular file.`)
  return full
}
// One implementation of "the digests this CLI is running", shared by the report's
// runtime-integrity map and by verify's question of whether this is the runtime the
// project pins. It reads this process's own benchmark directory, not the project's,
// and compares digests rather than directory paths: an export written here pins these
// exact bytes even though it sits somewhere else, and a project frozen by an earlier
// runtime pins different bytes even when it sits right here. A file this build does
// not carry is reported as absent, never as agreeing. The bytes are read, not a
// decoded string, so the digest is of the file itself. Each file is measured once,
// because the modules this process has already loaded cannot change under it.
const BENCHMARK_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const loadedDigests = new Map()
function loadedRuntimeDigest(file) {
  if (!loadedDigests.has(file)) loadedDigests.set(file, readFile(resolve(BENCHMARK_DIRECTORY, file)).then(sha256, () => null))
  return loadedDigests.get(file)
}
async function runningRuntimeDigests(project) {
  return Object.fromEntries(await Promise.all(runtimeFilesFor(project).map(async file => [file, await loadedRuntimeDigest(file)])))
}
async function pinnedRuntimeState(files, pins) {
  const differing = []
  for (const file of files) if (await loadedRuntimeDigest(file) !== pins[file]) differing.push(file)
  return { isThisRuntime: differing.length === 0, differing }
}
// When this process is not the pinned runtime it does not rebuild, and it does
// not load anything out of the archive either. A rebuild by a runtime that did
// not freeze the project says nothing about it. Running the archive's own
// cli.mjs would say something, but only by executing code carried by the very
// artifact under verification: digest binding proves that an archive is
// internally consistent, never that it is honest, so a crafted archive pinning
// its own crafted compiler would run inside this process. A read-only
// verification path never executes code from the artifact it verifies. What is
// left is what can be checked without the pinned compiler: the manifest's
// digests, project.json answering for its own, and the pins agreeing with both.
// That is reported as such, and the receipt says plainly that the pinned
// runtime was not run.
// Collecting new trials or qualifying an apparatus with a runtime other than
// the one the project pins would write a journal or a receipt naming source
// digests it was not produced by. Reading and reporting a finished run is safe,
// because a later generator renders the same pinned digests, but collection is
// not, so it is refused rather than recorded wrongly.
function requireThisRuntime(runtime, act) {
  invariant(runtime.isThisRuntime, `This project pins a runtime that differs from this one (${runtime.differing.join(', ')}), so ${act} here would not be the runtime the project names. Run the project's own cli.mjs inside the project directory.`)
}
export async function readProject(root) { return (await openProject(root)).project }
export async function openProject(root) {
  const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'))
  invariant(manifest.format === 'research-benchmark-files' && manifest.version === 1, 'Unrecognized project manifest.')
  invariant(manifest.files && typeof manifest.files === 'object' && !Array.isArray(manifest.files), 'The project file manifest is missing.')
  invariant(new Set(Object.keys(manifest.files).map(file => file.toLowerCase())).size === Object.keys(manifest.files).length, 'Manifest file paths collide on case-insensitive filesystems.')
  for (const [file, digest] of Object.entries(manifest.files)) {
    const full = await confinedFile(root, file)
    invariant(await sha256(await readFile(full)) === digest, `Frozen file changed: ${file}.`)
  }
  invariant(manifest.files['project.json'], 'The manifest omits project.json.')
  // project.json answers for its own digest, the manifest and the project name
  // the same project, and every pinned runtime file is one the manifest hashed
  // above. Only then is a runtime chosen, so the bytes are bound to the pins
  // before any code from the directory can be loaded.
  const declared = JSON.parse(await readFile(resolve(root, 'project.json'), 'utf8'))
  const { sha256: recorded, ...body } = declared
  invariant(typeof recorded === 'string' && await sha256(canonical(body)) === recorded, "The project's recorded SHA-256 does not match its own contents.")
  const RUNTIME_FILES = runtimeFilesFor(declared)
  for (const required of RUNTIME_FILES) invariant(manifest.files[required], `The manifest omits ${required}.`)
  invariant(manifest.projectSha256 === recorded, 'The manifest belongs to a different project.')
  for (const file of RUNTIME_FILES) invariant(declared.spec?.runtimeSources?.[file] === manifest.files[file], `The runtime source differs from the frozen project: ${file}.`)
  const runtime = await pinnedRuntimeState(RUNTIME_FILES, declared.spec.runtimeSources)
  // A foreign project is never rebuilt here, so verifyProject's shape check
  // never runs on it. Its digests can all agree while the file is still not a
  // frozen project, and reading counts off it would then fail with a runtime
  // type error instead of a sentence. Refuse by name: reporting ok on a file
  // that does not declare its own tasks would claim more than was checked,
  // which is the one thing this path exists to avoid.
  if (!runtime.isThisRuntime) {
    invariant(Array.isArray(declared.tasks) && Array.isArray(declared.schedule),
      'This project file matches its own digests but does not declare its tasks and schedule, so it is not a frozen project this runtime can report on.')
    return { project: declared, manifest, runtime, readiness: null }
  }
  const project = await verifyProject(declared)
  if (project.spec.environment?.nodeVersion) invariant(String(project.spec.environment.nodeVersion).replace(/^v/, '') === process.versions.node, `This project pins Node ${project.spec.environment.nodeVersion}; current runtime is ${process.version}.`)
  for (const condition of project.spec.conditions) if (condition.adapter.kind === 'module') invariant(manifest.files[condition.adapter.file], 'The manifest omits a custom adapter.')
  if (project.spec.protocol.grading.kind === 'module') invariant(manifest.files[project.spec.protocol.grading.file], 'The manifest omits the custom grader.')
  if (project.requirements?.interpreters) for (const kind of ['reference', 'independent']) {
    const binding = project.requirements.interpreters[kind]
    invariant(manifest.files[binding.file] === binding.sha256, 'The manifest omits or changes a qualification interpreter: ' + binding.file + '.')
  }
  for (const input of project.spec.inputs) invariant(await sha256(await readFile(await confinedFile(root, input.path))) === input.sha256, `Input changed: ${input.path}.`)
  const referenceSource = project.spec.domain === 'lean-bench' ? await readFile(await confinedFile(root, 'lean-reference.py'), 'utf8') : undefined
  const executionSource = project.spec.domain === 'lean-bench' ? await readFile(await confinedFile(root, 'execution_reference.py'), 'utf8') : undefined
  const operationalSources = operationalStudy(project.spec) ? Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(await confinedFile(root, file), 'utf8')]))) : undefined
  for (const [file, expected] of Object.entries(leanProjectFiles(project, referenceSource, executionSource, operationalSources))) {
    invariant(manifest.files[file], `The manifest omits a generated Lean artifact: ${file}.`)
    invariant(await readFile(await confinedFile(root, file), 'utf8') === expected, `Generated Lean artifact changed: ${file}.`)
  }
  for (const [file, expected] of Object.entries(auditProjectFiles(project))) invariant(await readFile(await confinedFile(root, file), 'utf8') === expected, `Generated audit artifact changed: ${file}.`)
  for (const [file, expected] of Object.entries(observationProjectFiles(project))) invariant(await readFile(await confinedFile(root, file), 'utf8') === expected, `Generated observation artifact changed: ${file}.`)
  for (const [file, expected] of Object.entries(compositionProjectFiles(project))) {
    invariant(manifest.files[file], 'The manifest omits a composition artifact: ' + file + '.')
    invariant(await readFile(await confinedFile(root, file), 'utf8') === expected, 'Generated composition artifact changed: ' + file + '.')
  }
  for (const [file, expected] of Object.entries(readinessProjectFiles(project))) {
    invariant(manifest.files[file], 'The manifest omits a generated readiness artifact: ' + file + '.')
    invariant(await readFile(await confinedFile(root, file), 'utf8') === expected, 'Generated readiness artifact changed: ' + file + '.')
  }
  for (const [file, expected] of Object.entries(requirementProjectFiles(project))) {
    invariant(manifest.files[file], 'The manifest omits a requirement artifact: ' + file + '.')
    invariant(await readFile(await confinedFile(root, file), 'utf8') === expected, 'Generated requirement artifact changed: ' + file + '.')
  }
  for (const [file, expected] of Object.entries(workflowProjectFiles(project))) {
    invariant(manifest.files[file], 'The manifest omits a workflow artifact: ' + file + '.')
    invariant(await readFile(await confinedFile(root, file), 'utf8') === expected, 'Generated workflow artifact changed: ' + file + '.')
  }
  for (const [file, expected] of Object.entries(corpusProjectFiles(project))) {
    invariant(manifest.files[file], 'The manifest omits a corpus artifact: ' + file + '.')
    invariant(await readFile(await confinedFile(root, file), 'utf8') === expected, 'Generated corpus artifact changed: ' + file + '.')
  }
  for (const [file, expected] of Object.entries(analysisProjectFiles(project))) {
    invariant(manifest.files[file], 'The manifest omits the frozen primary population artifact: ' + file + '.')
    invariant(await readFile(await confinedFile(root, file), 'utf8') === expected, 'Generated primary population artifact changed: ' + file + '.')
  }
  for (const [file, expected] of Object.entries(designProjectFiles(project))) {
    invariant(manifest.files[file], 'The manifest omits the frozen design artifact: ' + file + '.')
    invariant(await readFile(await confinedFile(root, file), 'utf8') === expected, 'Generated design artifact changed: ' + file + '.')
  }
  for (const [file, expected] of Object.entries(templateProjectFiles(project))) {
    invariant(manifest.files[file], 'The manifest omits a generated experiment artifact: ' + file + '.')
    invariant(await readFile(await confinedFile(root, file), 'utf8') === expected, 'Generated experiment artifact changed: ' + file + '.')
  }
  // Citation files are regenerated from the project. An export written before
  // they existed carries none; a present one must equal the regeneration.
  for (const [file, expected] of Object.entries(await templateCitationFiles(project))) {
    if (!manifest.files[file]) continue
    invariant(await readFile(await confinedFile(root, file), 'utf8') === expected, 'Generated citation artifact changed: ' + file + '.')
  }
  return { project, manifest, runtime, readiness: evaluateReadiness }
}
async function failedEnvelope(evidence, bytes, scope, provenance) {
  if (!scope) return evidence
  try {
    const value = await measuredPhase(scope, 'response-extraction', () => JSON.parse(canonical(JSON.parse(bytes))))
    return value && typeof value === 'object' && !Array.isArray(value) ? { ...value, [provenance]: evidence } : evidence
  } catch { return evidence } // The failed transport remains failed; raw bytes remain evidence.
}
export async function commandAdapter(root, adapter, request, signal, children = new Set(), measure) {
  let evidence
  try { evidence = await measuredPhase(measure, 'transport', () => new Promise((done, reject) => {
    const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP', ...(adapter.env || [])]
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
    if (adapter.credentialEnv && process.env[adapter.credentialEnv]) env[adapter.credentialEnv] = process.env[adapter.credentialEnv]
    // shell:false preserves exact arguments on every platform. Adapter commands
    // must wait for their own descendants; POSIX groups are killed on abort.
    const child = spawn(adapter.command, adapter.args, { cwd: root, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
    children.add(child)
    const out = [], err = []
    let size = 0, failure = null
    const stop = () => {
      failure ||= signal.reason || new Error('Command cancelled.')
      if (!child.pid) return
      if (process.platform === 'win32') {
        const terminator = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        terminator.on('error', () => child.kill())
      } else {
        try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') failure = error }
      }
    }
    signal.addEventListener('abort', stop, { once: true })
    if (signal.aborted) stop()
    const capture = channel => bytes => {
      size += bytes.length
      if (size > MAX_OUTPUT) { failure = new Error('Command output exceeds 8 MiB.'); stop(); return }
      ;(channel === 'stdout' ? out : err).push(bytes)
    }
    child.stdout.on('data', capture('stdout')); child.stderr.on('data', capture('stderr'))
    child.on('error', error => { failure = error })
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') failure = error })
    child.on('close', (code, killedBy) => {
      children.delete(child); signal.removeEventListener('abort', stop)
      const stdout = Buffer.concat(out).toString('utf8'), stderr = Buffer.concat(err).toString('utf8')
      const evidence = { stdout, stderr, exitCode: code, signal: killedBy }
      if (failure || code !== 0) { const error = failure || new Error(`Command exited with code ${code}.`); error.evidence = evidence; if (!failure && adapter.moduleHost && code === 65) error.code = 'RESPONSE_EXTRACTION'; reject(error); return }
      done(evidence)
    })
    child.stdin.end(canonical(request) + '\n')
  })) } catch (error) {
    if (error.evidence) error.evidence = await failedEnvelope(error.evidence, error.evidence.stdout, measure, 'process')
    throw error
  }
  return measuredPhase(measure, 'response-extraction', () => {
    let value
    try {
      value = JSON.parse(canonical(JSON.parse(evidence.stdout)))
      invariant(value && Object.hasOwn(value, 'output'), 'Command must print one JSON object with an output field.')
      return { ...value, process: evidence }
    } catch (error) { error.code = 'RESPONSE_EXTRACTION'; error.evidence = measure && value && typeof value === 'object' && !Array.isArray(value) ? { ...value, process: evidence } : evidence; throw error }
  })
}

// Stored custom grades are derived data. Re-run their frozen module in the
// same bounded child host before trusting an existing journal for a summary
// or resume. This does not dispatch another study trial or modify raw records.
export async function auditCustomGrades(root, project, events, signal = new AbortController().signal) {
  if (project.spec.protocol.grading.kind !== 'module') return
  const completed = events.filter(event => event.type === 'finished' && event.status === 'completed')
  if (!completed.length) return
  const file = await confinedFile(root, project.spec.protocol.grading.file)
  const deadline = Date.now() + project.spec.protocol.maxDurationMs
  for (const event of completed) {
    signal.throwIfAborted()
    const recorded = recordedCustomGrade(event)
    const remaining = Math.min(project.spec.protocol.timeoutMs, deadline - Date.now())
    invariant(remaining > 0, 'Custom grade verification exceeded the declared time budget.')
    const trial = project.schedule.find(row => row.id === event.trialId)
    const task = project.tasks.find(row => row.id === trial.taskId)
    const controller = new AbortController()
    const cancel = () => controller.abort(signal.reason || new Error('Grade verification cancelled.'))
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    const timer = setTimeout(() => controller.abort(new Error('Custom grade verification timed out.')), remaining)
    try {
      const response = await commandAdapter(root, { command: process.execPath, args: [resolve(root, 'module-host.mjs'), file, 'grade'] },
        { project, task, output: event.response.output }, controller.signal)
      try {
        const grade = customGradeResult(response.output, 'The custom grader returned no valid verification result.')
        // The original process receipt stays intact. Fresh process logs describe
        // another execution; compare only its complete deterministic JSON result.
        invariant(canonical(grade) === canonical(recorded), `The recorded custom grade disagrees with its retained response: ${event.trialId}.`)
      } catch (error) { error.evidence = { output: response.output, process: response.process }; throw error }
    } finally { clearTimeout(timer); signal.removeEventListener('abort', cancel) }
  }
}

export function createAdapter(root, children = new Set()) {
  return async args => {
    const { project, condition, task, trial, attempt, signal, measure } = args
    const adapter = condition.adapter
    const request = args.request || collectionRequest(project, condition, task, trial, attempt)
    const templateLimit = project.experimentTemplate?.limits?.maxResponseBytes
    // The HTTP receipt retains both parsed JSON and original text. Reserve
    // space for JSON escaping and host metadata inside the envelope limit.
    const bodyLimit = templateLimit ? Math.floor((templateLimit - 512) / 3) : MAX_OUTPUT
    if (adapter.kind === 'replay') return replayAdapter(args)
    if (adapter.kind === 'command') return commandAdapter(root, adapter, request, signal, children, measure)
    if (adapter.kind === 'module') {
      const module = await confinedFile(root, adapter.file)
      return commandAdapter(root, { command: process.execPath, args: [resolve(root, 'module-host.mjs'), module, 'run'], env: adapter.env, credentialEnv: adapter.credentialEnv, moduleHost: true }, request, signal, children, measure)
    }
    const token = adapter.credentialEnv ? process.env[adapter.credentialEnv] : null
    invariant(!adapter.credentialEnv || token, `Set ${adapter.credentialEnv} before running this condition.`)
    const chunks = []; let size = 0, response, body, overflow = false
    try {
      await measuredPhase(measure, 'transport', async () => {
        response = await fetch(adapter.url, { method: 'POST', signal, redirect: 'error', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: canonical(request) })
        for await (const bytes of response.body) {
          const remaining = bodyLimit - size
          size += bytes.length
          if (size > bodyLimit) {
            overflow = true
            if (remaining > 0) chunks.push(Buffer.from(bytes.subarray(0, remaining)))
            throw new Error(templateLimit ? 'HTTP response exceeds the generated experiment response bound; only a diagnostic prefix is retained.' : 'HTTP response exceeds 8 MiB.')
          }
          chunks.push(Buffer.from(bytes))
        }
        body = Buffer.concat(chunks).toString('utf8')
      })
      invariant(response.ok, `HTTP response status ${response.status}.`)
    } catch (error) {
      const evidence = { body: Buffer.concat(chunks).toString('utf8'), status: response?.status ?? null,
        ...(overflow ? { incomplete: true, reason: 'response-byte-limit', receivedBytesAtLeast: size, retainedBodyLimit: bodyLimit } : {}) }
      error.evidence = await failedEnvelope(evidence, evidence.body, measure, 'http'); throw error
    }
    return measuredPhase(measure, 'response-extraction', () => {
      let decoded
      try {
        decoded = JSON.parse(canonical(JSON.parse(body)))
        invariant(decoded && Object.hasOwn(decoded, 'output'), 'HTTP adapter must return JSON with an output field.')
        return { ...decoded, http: { body, status: response.status } }
      } catch (error) { error.code = 'RESPONSE_EXTRACTION'; const evidence = { body, status: response.status }; error.evidence = measure && decoded && typeof decoded === 'object' && !Array.isArray(decoded) ? { ...decoded, http: evidence } : evidence; throw error }
    })
  }
}
async function journalAt(output) {
  try {
    const text = await readFile(resolve(output, 'attempts.jsonl'), 'utf8')
    invariant(!text || text.endsWith('\n'), 'The journal has an incomplete final write. Preserve it and repair the journal before resuming.')
    return text.split('\n').filter(Boolean).map(line => JSON.parse(line))
  } catch (error) { if (error.code === 'ENOENT') return []; throw error }
}

// Retained native verification has its own bounded, no-symlink reader. The
// existing project and journal readers keep their historical behavior.
async function nativePath(root, file, required = true) {
  invariant(safePath(file), `Invalid native evidence path: ${file}.`)
  const base = resolve(root), full = resolve(base, file)
  invariant(full.startsWith(base + sep), `Native evidence leaves its directory: ${file}.`)
  const anchor = pathParts(full).root, parts = full.slice(anchor.length).split(sep).filter(Boolean)
  let current = anchor
  for (let index = 0; index < parts.length; index++) {
    current = resolve(current, parts[index])
    let info
    try { info = await lstat(current) }
    catch (error) { if (!required && error.code === 'ENOENT') return null; throw error }
    invariant(!info.isSymbolicLink(), `Native evidence cannot use a symlink: ${current}.`)
    invariant(index === parts.length - 1 ? info.isFile() : info.isDirectory(), `Native evidence needs regular files and directories: ${current}.`)
    if (index === parts.length - 1) return { full, info }
  }
}
async function nativeBytes(root, file, budget, { required = true, maxBytes = NATIVE_EVIDENCE_LIMITS.fileBytes } = {}) {
  const found = await nativePath(root, file, required)
  if (!found) return null
  const limit = Math.min(maxBytes, NATIVE_EVIDENCE_LIMITS.fileBytes, NATIVE_EVIDENCE_LIMITS.totalBytes - budget.bytes)
  invariant(found.info.size <= limit, `Native evidence exceeds its file or aggregate byte limit: ${file}.`)
  const handle = await open(found.full, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0))
  try {
    const actual = await handle.stat(), checked = await nativePath(root, file)
    invariant(actual.isFile() && actual.dev === found.info.dev && actual.ino === found.info.ino
      && checked.info.dev === actual.dev && checked.info.ino === actual.ino && await realpath(found.full) === found.full,
    `Native evidence changed while opening: ${file}.`)
    invariant(actual.size <= limit, `Native evidence exceeds its file or aggregate byte limit: ${file}.`)
    const chunks = []; let length = 0
    while (true) {
      const chunk = Buffer.alloc(Math.min(65536, limit - length + 1)), { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
      if (!bytesRead) break
      length += bytesRead
      invariant(length <= limit, `Native evidence exceeds its file or aggregate byte limit: ${file}.`)
      chunks.push(chunk.subarray(0, bytesRead))
    }
    budget.bytes += length
    return Buffer.concat(chunks, length)
  } finally { await handle.close() }
}
const nativeText = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
const nativeFileValue = bytes => { try { return nativeText(bytes) } catch { return { encoding: 'base64', data: bytes.toString('base64') } } }
function nativeJson(value) {
  const text = canonical(value) + '\n'
  invariant(Buffer.byteLength(text) <= NATIVE_EVIDENCE_LIMITS.totalBytes, 'Serialized native evidence exceeds 64 MiB.')
  return text
}
async function publishNativeFiles(output, entries) {
  const owned = []
  try {
    for (const [name, contents] of entries) {
      // The retained journal establishes the output directory; never create
      // another directory or traverse a replacement symlink for publication.
      await nativePath(output, 'attempts.jsonl')
      const path = resolve(output, name), handle = await open(path, 'wx', 0o600)
      const row = { path, handle, info: null }; owned.push(row); row.info = await handle.stat()
      await handle.writeFile(contents); await handle.sync(); await handle.close(); row.handle = null
    }
  } catch (error) {
    const retained = []
    for (const row of owned.reverse()) {
      await row.handle?.close().catch(() => {})
      try {
        const current = await lstat(row.path)
        invariant(row.info && current.dev === row.info.dev && current.ino === row.info.ino, 'The publication path changed ownership.')
        await rm(row.path)
      } catch (cleanup) { if (cleanup.code !== 'ENOENT') retained.push(row.path) }
    }
    throw new Error(`${error.message} Native verification publication failed. ${retained.length
      ? 'Partial publication remains at: ' + retained.join(', ') + '. Inspect these files before retrying.'
      : 'No new verification artifacts were retained.'}`, { cause: error })
  }
}

export async function verifyNativeProjectEvidence(root, { output = resolve(root, 'results') } = {}) {
  root = resolve(root); output = resolve(output)
  const budget = { bytes: 0 }
  const project = JSON.parse(nativeText(await nativeBytes(root, 'project.json', budget)))
  const journal = nativeText(await nativeBytes(output, 'attempts.jsonl', budget))
  invariant(!journal || journal.endsWith('\n'), 'The native journal has an incomplete final write; retain and repair it before verification.')
  const events = journal.split('\n').filter(Boolean).map(line => JSON.parse(line))
  await verifyProject(project)
  const plan = nativeEvidencePaths(project, events.filter(event => event?.type === 'finished' && event.status === 'completed')), files = {}
  for (const item of plan.files) {
    const bytes = await nativeBytes(item.location === 'project' ? root : output, item.path, budget, item)
    if (bytes !== null) files[item.key] = nativeFileValue(bytes)
  }
  const bundle = { format: 'benchmark-native-evidence', version: 1, project, events, files }
  const encoded = nativeJson(bundle)
  const receipt = await verifyNativeJournalEvidence({ project, events, files }), verification = nativeJson(receipt)
  await publishNativeFiles(output, [['native-evidence.json', encoded], ['native-verification.json', verification]])
  return { evidence: resolve(output, 'native-evidence.json'), verification: resolve(output, 'native-verification.json'),
    projectSha256: project.sha256, evidenceStatus: 'retained-artifact-consistency', attempts: receipt.attempts.length }
}
async function releaseOwnedLock(lock, owner) {
  invariant(await readFile(resolve(lock, 'owner.json'), 'utf8') === owner, 'The run lock owner changed. Inspect the retained lock before retrying.')
  await rm(lock, { recursive: true })
}
async function claim(output, recover, project) {
  await mkdir(output, { recursive: true })
  const lock = resolve(output, '.run-lock'), gate = resolve(output, '.recovery-lock')
  const owner = canonical({ pid: process.pid, startedAt: new Date().toISOString(), token: randomUUID() })
  // Every claim takes this short exclusive gate. Two recoveries must never
  // inspect one stale owner and then remove each other's replacement lock.
  // A crash leaves the gate for explicit inspection, including when no run
  // lock remains; a new run cannot bypass an unfinished recovery.
  try { await mkdir(gate) } catch (error) {
    if (error.code !== 'EEXIST') throw error
    throw new Error('Another run claim or recovery holds .recovery-lock. If it has stopped, inspect that directory before retrying.')
  }
  let gateRecorded = false
  try {
    await writeFile(resolve(gate, 'owner.json'), owner, { flag: 'wx' }); gateRecorded = true
    try { await mkdir(lock) } catch (error) {
      if (error.code !== 'EEXIST') throw error
      invariant(recover, 'This output directory is locked. Inspect its run, then use run --recover only after it has stopped.')
      const originalOwner = await readFile(resolve(lock, 'owner.json'), 'utf8'), previous = JSON.parse(originalOwner)
      invariant(Number.isSafeInteger(previous.pid) && previous.pid > 0, 'The recorded run owner is invalid; inspect its lock before recovery.')
      let missing = false
      try { process.kill(previous.pid, 0) } catch (check) { missing = check.code === 'ESRCH' }
      invariant(missing, 'The recorded run process still exists or cannot be checked; recovery is refused.')
      if (project.spec.protocol.grading.kind === 'lean-python') await recoverLeanResources(output, project.sha256)
      await releaseOwnedLock(lock, originalOwner)
      await mkdir(lock)
    }
    await writeFile(resolve(lock, 'owner.json'), owner, { flag: 'wx' })
  } finally {
    if (gateRecorded) await releaseOwnedLock(gate, owner)
    // A failed owner write leaves the gate available for inspection. No run
    // has been dispatched, and an incomplete ownership record is not guessed.
  }
  return () => releaseOwnedLock(lock, owner)
}
// An export may carry its provenance registry and ATTRIBUTIONS.md beside the
// project. The report renders the registry verbatim and retains ATTRIBUTIONS.md;
// a missing file is reported as not declared.
async function projectProvenance(root) {
  try { return JSON.parse(await readFile(resolve(root, 'provenance.json'), 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
async function projectAttributions(root) {
  try { return await readFile(resolve(root, 'ATTRIBUTIONS.md'), 'utf8') }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
// Receipts written beside the journal: results/qualification.json by `qualify`
// and results/native-verification.json by `verify-native`. They are read as
// written; report.mjs refuses one that does not bind to this project and this
// journal, so a stale receipt stops the analysis instead of being rendered.
async function retainedReceipt(output, name) {
  let text
  try { text = await readFile(resolve(output, name), 'utf8') } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  try { return JSON.parse(text) } catch (error) { throw new Error(`${name} beside the journal is not readable JSON: ${error.message}`) }
}
async function retainedReceipts(output) {
  return { qualification: await retainedReceipt(output, 'qualification.json'), nativeVerification: await retainedReceipt(output, 'native-verification.json') }
}
// evidence.json is what the Research page imports. Each receipt travels with the
// SHA-256 of its canonical bytes, the same digest the report prints, so the page
// can refuse a receipt whose bytes no longer match what the CLI embedded.
async function evidenceDocument(project, events, summary, receipts) {
  const evidence = { projectSha256: project.sha256, events, summary }
  if (receipts.qualification) { evidence.qualification = receipts.qualification; evidence.qualificationSha256 = await sha256(canonical(receipts.qualification)) }
  if (receipts.nativeVerification) { evidence.nativeVerification = receipts.nativeVerification; evidence.nativeVerificationSha256 = await sha256(canonical(receipts.nativeVerification)) }
  return JSON.stringify(evidence, null, 2) + '\n'
}
// The manifest.json beside the project is the export manifest the report summarises.
async function projectManifest(root) {
  try { return await readFile(resolve(root, 'manifest.json'), 'utf8') }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
async function writeAnalysis(output, project, events, root, receipts = null) {
  receipts ??= await retainedReceipts(output)
  for (const [file, contents] of Object.entries(await researchReportFiles(project, events, { provenance: await projectProvenance(root), attributions: await projectAttributions(root), manifest: await projectManifest(root), qualification: receipts.qualification, nativeVerification: receipts.nativeVerification, runtimeIntegrity: await runningRuntimeDigests(project) }))) {
    const target = resolve(output, file)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, contents)
  }
}
export async function runProject(root, { output = resolve(root, 'results'), recover = false, signal = new AbortController().signal } = {}) {
  const { project, runtime } = await openProject(root)
  requireThisRuntime(runtime, 'collecting trials')
  const originalManifest = await sha256(await readFile(resolve(root, 'manifest.json')))
  const unlock = await claim(output, recover, project)
  let journal, qualifying, keepLock = false, qualificationUnsettled = false
  try {
    const events = await journalAt(output)
    await verifyQualificationJournal(project, events)
    await verifyResourceJournal(project, events)
    const unfinished = validateJournal(project, events)
    for (const start of unfinished) {
      let retained = false
      try { await lstat(resolve(output, 'responses', `${start.trialId}-${start.attempt}.json`)); retained = true } catch (error) { if (error.code !== 'ENOENT') throw error }
      invariant(!retained, 'An interrupted attempt already has a retained system response. Inspect responses/ and reuse it after repairing the grader; recovery cannot redraw the answer.')
    }
    await auditCustomGrades(root, project, events, signal)
    journal = await open(resolve(output, 'attempts.jsonl'), 'a')
    const children = new Set()
    const grade = project.spec.protocol.grading.kind === 'module'
      ? async (project, task, output, { signal, measure }) => {
        const file = await confinedFile(root, project.spec.protocol.grading.file)
        const value = await measuredPhase(measure, 'module-grader', scope => commandAdapter(root, { command: process.execPath, args: [resolve(root, 'module-host.mjs'), file, 'grade'] }, { project, task, output }, signal, children, scope))
        try { return { ...customGradeResult(value.output, 'The custom grader returned no valid result.'), process: value.process } }
        catch (error) { error.evidence = { output: value.output, process: value.process }; throw error }
      } : project.spec.protocol.grading.kind === 'lean-python' ? (project, task, response, context) => gradeLean(project, task, response, { ...context, root, artifacts: resolve(output, 'artifacts'), children }) : gradeResponse
    invariant(typeof grade === 'function', 'The custom grader must export grade(project, task, output).')
    const result = await runStudy(project, { events, recover, signal, adapter: project.spec.conditions.every(condition => condition.adapter.kind === 'replay') ? replayAdapter : createAdapter(root, children), grade,
      qualify: (current, { signal, preparationSeq }) => {
        invariant(Number.isSafeInteger(preparationSeq) && preparationSeq > 0, 'Qualification needs its durable preparation sequence before execution.')
        const directory = resolve(output, 'preflight', preparationSeq + '-' + randomUUID())
        qualifying = (async () => {
          await mkdir(directory, { recursive: true })
          await writeFile(resolve(directory, 'started.json'), JSON.stringify({ projectSha256: current.sha256, preparationSeq, registrySha256: current.requirements.sha256,
            runtimeSources: current.spec.runtimeSources, policy: selectedInputGate(current), startedAt: new Date().toISOString() }, null, 2) + '\n')
          try {
            const record = await qualifyProject(root, current, { signal })
            signal.throwIfAborted(); await readProject(root)
            await writeFile(resolve(directory, 'qualification.json'), JSON.stringify(record, null, 2) + '\n')
            for (const [file, contents] of Object.entries(requirementReportFiles(record))) { await mkdir(dirname(resolve(directory, file)), { recursive: true }); await writeFile(resolve(directory, file), contents) }
            signal.throwIfAborted(); return record
          } catch (error) {
            await writeFile(resolve(directory, 'failure.json'), JSON.stringify({ projectSha256: current.sha256, preparationSeq, error: error.message || String(error),
              cancelled: signal.aborted, ...(error.evidence ? { process: error.evidence } : {}),
              ...(error.partialQualification ? { partialQualification: error.partialQualification } : {}) }, null, 2) + '\n')
            throw error
          }
        })()
        return qualifying
      },
      runtime: { node: process.version, platform: process.platform, architecture: process.arch, versions: process.versions },
      recordResponse: async response => {
        await mkdir(resolve(output, 'responses'), { recursive: true })
        const file = await open(resolve(output, 'responses', `${response.trialId}-${response.attempt}.json`), 'wx')
        try { await file.write(canonical(response) + '\n'); await file.sync() } finally { await file.close() }
      },
      settle: async () => { await Promise.all([...children].map(child => new Promise(resolve => child.once('close', resolve)))); return true },
      append: async event => { await journal.write(canonical(event) + '\n'); await journal.sync() } })
    // A cancelled command may still be closing its pipes. Keep the run lock
    // until those owned children have actually emitted close.
    await Promise.all([...children].map(child => new Promise(resolve => child.once('close', resolve))))
    invariant(originalManifest === await sha256(await readFile(resolve(root, 'manifest.json'))), 'The project manifest changed during the run. Raw attempts are retained; the run is not verified.')
    await readProject(root) // Verify pinned inputs and source again after execution.
    const receipts = await retainedReceipts(output)
    await writeAnalysis(output, project, result.events, root, receipts)
    await writeFile(resolve(output, 'evidence.json'), await evidenceDocument(project, result.events, result.summary, receipts))
    return result
  } catch (error) {
    keepLock = error.keepLock === true
    qualificationUnsettled = keepLock && error.qualificationUnsettled === true
    throw error
  } finally {
    // The runner already attempted its bounded qualification join. An
    // unresolved qualifier must not turn that bounded failure into an
    // unbounded finally wait. Its original lock and late side evidence remain.
    if (qualificationUnsettled) qualifying?.catch(() => {})
    else await qualifying?.catch(() => {})
    await journal?.close(); if (!keepLock) await unlock()
  }
}
export async function main(args = process.argv.slice(2)) {
  const command = args[0] || 'help'
  if (command === 'help' || command === '--help') {
    process.stdout.write('Benchmark CLI (Node 22+)\nnode cli.mjs verify | readiness | qualify [--python COMMAND] | run [--recover] | status | analyze | reference | verify-native\nOptional: --project DIRECTORY --output DIRECTORY\nverify-native checks retained native artifact bytes without execution and writes new native-evidence.json/native-verification.json.\nCommands receive one JSON request on stdin and return {"output":...} on stdout.\n')
    return
  }
  invariant(['verify', 'readiness', 'qualify', 'run', 'status', 'analyze', 'reference', 'verify-native'].includes(command), 'Unknown benchmark command. Use node cli.mjs help.')
  const options = {}
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--recover') options.recover = true
    else if (args[i] === '--compact') options.compact = true
    else if (['--project', '--output', '--python'].includes(args[i])) { invariant(args[i + 1] && !args[i + 1].startsWith('--'), `Missing value for ${args[i]}.`); options[args[i].slice(2)] = args[++i] }
    else throw new Error(`Unknown option ${args[i]}.`)
  }
  const root = resolve(options.project || dirname(fileURLToPath(import.meta.url)))
  const output = resolve(options.output || resolve(root, 'results'))
  if (command === 'verify-native') {
    invariant(!options.recover && !options.python && !options.compact, 'verify-native accepts only --project and --output; it cannot recover, execute or regrade.')
    process.stdout.write(canonical(await verifyNativeProjectEvidence(root, { output })) + '\n'); return
  }
  if (command === 'verify' || command === 'readiness') {
    const { project, runtime, readiness: evaluate } = await openProject(root)
    // Name what actually gave the verdict, so a reader never has to guess how
    // much this receipt is worth. This runtime judges only a project that pins
    // it. For any other project the operations are null, because no runtime
    // here evaluated them, and the contract the project carries is reported as
    // the data it is rather than as a verdict this process reached.
    const readiness = evaluate
      ? { collect: evaluate(project, { operation: 'collect' }), diagnosticReplay: evaluate(project, { operation: 'diagnostic-replay' }), apparatusDevelopment: evaluate(project, { operation: 'apparatus-development' }) }
      : { collect: null, diagnosticReplay: null, apparatusDevelopment: null, recorded: project.readiness ?? null }
    const verdict = runtime.isThisRuntime
      ? { verifiedBy: 'this-runtime', filesDiffering: 0 }
      : { verifiedBy: 'project-digests', filesDiffering: runtime.differing.length,
          note: "This project pins a runtime this process is not, so the pinned runtime was not run and nothing from the archive was executed. What is checked here is the project's own digests: every frozen file against the manifest, project.json against its own recorded SHA-256, and every pinned runtime source against both. For that runtime's own verdict, run the project's cli.mjs inside its directory." }
    // Both fields live in one receipt: T2's studyVersion, which is the
    // investigator's own release number for the study, and the runtime
    // verdict above, which says whose rebuild judged it. A foreign project
    // still has a declared spec, so its version reads the same way.
    process.stdout.write(canonical({ ok: true, projectSha256: project.sha256, studyVersion: project.spec.version ?? null,
      tasks: project.tasks.length, trials: project.schedule.length, runtime: verdict, readiness }) + '\n'); return
  }
  if (command === 'qualify') {
    const controller = new AbortController(), stop = () => controller.abort(new Error('Qualification interrupted by the user.'))
    process.once('SIGINT', stop); process.once('SIGTERM', stop)
    let timer
    try {
      const { project, runtime } = await openProject(root)
      requireThisRuntime(runtime, 'qualifying the apparatus')
      if (project.requirements?.selectedInput) timer = setTimeout(() => controller.abort(new Error('Qualification exceeded its frozen selected-input time budget.')), project.requirements.selectedInput.timeoutMs)
      const record = await qualifyProject(root, project, { python: options.python, signal: controller.signal })
      controller.signal.throwIfAborted(); await readProject(root)
      await mkdir(output, { recursive: true }); await writeFile(resolve(output, 'qualification.json'), JSON.stringify(record, null, 2) + '\n')
      for (const [file, contents] of Object.entries(requirementReportFiles(record))) { await mkdir(dirname(resolve(output, file)), { recursive: true }); await writeFile(resolve(output, file), contents) }
      process.stdout.write(canonical(record) + '\n')
      if (record.requirements && (record.requirements.status !== 'qualified' || record.requirements.selectedInput && (record.requirements.selectedInput.registeredStatus !== 'qualified'
        || record.requirements.selectedInput.policy === 'require-composition' && record.requirements.selectedInput.compositionStatus !== 'qualified'))) process.exitCode = 1
    } catch (error) {
      if (error.partialQualification) {
        const directory = resolve(output, 'qualification-failures', randomUUID()); await mkdir(directory, { recursive: true })
        await writeFile(resolve(directory, 'failure.json'), JSON.stringify({ error: error.message || String(error), cancelled: controller.signal.aborted,
          partialQualification: error.partialQualification, ...(error.evidence ? { process: error.evidence } : {}) }, null, 2) + '\n')
      }
      throw error
    } finally { clearTimeout(timer); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop) }
    return
  }
  if (command !== 'run') {
    // Regrading starts owned child work just like run. Keep this process alive
    // on cancellation until the bounded host has confirmed its child closed.
    const controller = new AbortController(), stop = () => controller.abort(new Error('Grade verification interrupted by the user.'))
    process.once('SIGINT', stop); process.once('SIGTERM', stop)
    try {
      const project = await readProject(root), events = await journalAt(output)
      await verifyQualificationJournal(project, events)
      await verifyResourceJournal(project, events)
      validateJournal(project, events)
      await auditCustomGrades(root, project, events, controller.signal)
      controller.signal.throwIfAborted()
      if (command === 'reference') {
        const files = {}
        for (const item of auditReferencePaths(project, events)) {
          controller.signal.throwIfAborted()
          const bytes = await readFile(await confinedFile(item.location === 'project' ? root : output, item.path))
          try { files[item.key] = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
          catch { files[item.key] = { encoding: 'base64', data: bytes.toString('base64') } }
        }
        const bundle = await sealAuditReference(project, events, files), file = resolve(output, 'reference-bundle.json')
        await mkdir(output, { recursive: true }); await writeFile(file, canonical(bundle) + '\n')
        process.stdout.write(canonical({ reference: file, sha256: bundle.sha256, projectSha256: project.sha256 }) + '\n'); return
      }
      const summary = analyze(project, events)
      if (command === 'analyze') {
        // analyze derives evidence.json as well, so a receipt written after the
        // run (verify-native) reaches the file the Research page imports.
        const receipts = await retainedReceipts(output)
        await writeAnalysis(output, project, events, root, receipts)
        await writeFile(resolve(output, 'evidence.json'), await evidenceDocument(project, events, summary, receipts))
      }
      process.stdout.write(canonical(summary) + '\n'); return
    } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop) }
  }
  const controller = new AbortController(), stop = () => controller.abort(new Error('Run interrupted by the user.'))
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  try {
    const { summary } = await runProject(root, { output, recover: options.recover, signal: controller.signal })
    // Existing ToolsEnabled process collectors accept this structured result.
    process.stdout.write(canonical({ answer: `${summary.completed}/${summary.scheduled} trials completed`, completed: summary.completed, failed: summary.failed, scheduled: summary.scheduled, evidence: resolve(output, 'evidence.json'), projectSha256: summary.projectSha256, ...(options.compact ? {} : { summary }) }) + '\n')
    if (controller.signal.aborted) process.exitCode = 130
    else if (summary.completed !== summary.scheduled) process.exitCode = 2
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop) }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1 })
