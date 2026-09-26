// Open a project that some runtime exported, which is not the same act as
// freezing one here. Two questions must stay apart, because answering the first
// does not answer the second:
//
//   integrity - is this archive intact and internally consistent? Always
//               answerable from the bytes alone, with no pinned runtime.
//   rebuild   - can THIS runtime recompile the project byte for byte? Only
//               answerable when the compiler has not moved since the freeze.
//
// The exported CLI never faces the second question, because it runs from inside
// the archive and IS the pinned runtime. A page is not, so a rebuild failure is
// reported rather than thrown: the caller may admit a project it cannot rebuild,
// as long as it never claims to have verified it.
import { canonical, invariant, sha256 } from './prompts.mjs'
import { freezeStudy, runtimeFilesFor, verifyProject } from './study.mjs'

const MANIFEST = 'manifest.json', PROJECT = 'project.json'

// Report where two compiled projects differ, so a refusal can name the cause
// instead of only announcing that something changed.
function differingPaths(left, right, path = '', found = []) {
  if (found.length >= 32 || canonical(left ?? null) === canonical(right ?? null)) return found
  const branch = value => value !== null && typeof value === 'object'
  if (!branch(left) || !branch(right) || Array.isArray(left) !== Array.isArray(right)) { found.push(path || '(whole project)'); return found }
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) differingPaths(left[key], right[key], path ? path + '.' + key : key, found)
  return found
}

export async function readExportedProject(files, { sources = null } = {}) {
  invariant(files && typeof files === 'object', 'Open an exported project archive.')
  invariant(typeof files[MANIFEST] === 'string', 'This archive is not an exported project: it has no manifest.json.')
  let manifest
  try { manifest = JSON.parse(files[MANIFEST]) } catch { throw new Error('This archive is not an exported project: its manifest.json is not readable.') }
  invariant(manifest?.format === 'research-benchmark-files' && manifest.version === 1 && manifest.files && typeof manifest.files === 'object',
    'This archive is not an exported project: its manifest.json is not a version 1 project manifest.')

  let checked = 0
  for (const [name, digest] of Object.entries(manifest.files)) {
    invariant(typeof files[name] === 'string', `The archive is missing ${name}, which its manifest lists.`)
    invariant(await sha256(files[name]) === digest, `The archive's ${name} does not match the digest its manifest records.`)
    checked++
  }
  invariant(manifest.files[PROJECT], 'This archive is not an exported project: its manifest omits project.json.')

  let project
  try { project = JSON.parse(files[PROJECT]) } catch { throw new Error("The archive's project.json is not readable.") }
  invariant(manifest.projectSha256 === project?.sha256, 'This manifest belongs to a different project than its project.json.')
  const { sha256: recorded, ...body } = project
  invariant(await sha256(canonical(body)) === recorded, "The project's recorded SHA-256 does not match its own contents.")

  const runtimeFiles = runtimeFilesFor(project)
  for (const file of runtimeFiles) {
    invariant(manifest.files[file], `This archive is not runnable: its manifest omits the pinned runtime file ${file}.`)
    invariant(project.spec?.runtimeSources?.[file] === manifest.files[file], `The archive's ${file} differs from the runtime the project pins.`)
  }

  // Whether the runtime reading this archive is the runtime that wrote it.
  const runtime = { compared: false, matches: false, differing: [] }
  if (sources) {
    runtime.compared = true
    for (const file of runtimeFiles) {
      const here = typeof sources[file] === 'string' ? await sha256(sources[file]) : null
      if (here !== project.spec.runtimeSources[file]) runtime.differing.push(file)
    }
    runtime.matches = runtime.differing.length === 0
  }

  // verifyProject is the verdict, exactly as the exported CLI takes it. The
  // rebuild diff below is only the explanation of a refusal.
  const rebuild = { verified: false, reason: null, differing: [] }
  try { await verifyProject(project); rebuild.verified = true }
  catch (error) {
    try { rebuild.differing = differingPaths(project, await freezeStudy(project.spec)) }
    catch (rebuildError) { rebuild.differing = []; rebuild.reason = `${error.message} This runtime cannot recompile it at all: ${rebuildError.message}` }
    if (!rebuild.reason) rebuild.reason = rebuild.differing.length
      ? `This runtime rebuilds the project differently, at ${rebuild.differing.join(', ')}. The archive is intact; it was frozen by a runtime that compiled these fields differently.`
      : error.message
  }

  return { project, manifest: { files: checked }, integrity: { ok: true, checked }, runtime, rebuild }
}
