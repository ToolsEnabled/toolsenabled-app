import assert from 'node:assert/strict'
import test from 'node:test'
import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { canonical, sha256 } from '../../src/benchmark/prompts.mjs'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { genericStarter, newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { projectFiles } from '../../src/benchmark/export.mjs'
import { openProject, readProject } from '../../src/benchmark/cli.mjs'

// An exported study must stay verifiable by the runtime it pins, for as long as
// its bytes survive. That is the reproducibility claim its report makes, and it
// is not the same claim as "this tree would compile the same project today".
// The two answers diverge the moment any compiler or generator moves, and a
// project frozen before it moved is not wrong: it was frozen by a different
// compiler, and only that compiler's rebuild says anything about it.
//
// The situation is built here instead of borrowed from a stored artifact, so
// the test names no path outside this repository. A copy of this runtime with
// one derived readiness sentence reworded is "the earlier runtime": it freezes
// and exports a project pinning its own bytes, and this tree then reads that
// project.

const BENCHMARK = new URL('../../src/benchmark/', import.meta.url)
const SENTENCE = 'Sent-request context only: the ordinary request contains the frozen public prompt and input;'
const EARLIER = 'Sent-request context only (earlier wording): the ordinary request contains the frozen public prompt and input;'

function draft() {
  const seed = genericStarter()
  seed.tasks.length = 1
  seed.analysisPlan.primaryPopulation = 'all'
  return newExperimentDraft(seed)
}
async function scratch(t, label) {
  const root = await mkdtemp(resolve(tmpdir(), label))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
async function write(root, files) {
  for (const [file, text] of Object.entries(files)) {
    await mkdir(dirname(resolve(root, file)), { recursive: true })
    await writeFile(resolve(root, file), text)
  }
}
// A whole copy of this runtime with one sentence of the derived readiness
// contract reworded, so its compiler output differs from this tree's by exactly
// that sentence and nothing else.
async function earlierRuntime(t) {
  const root = await scratch(t, 'earlier-runtime-')
  await cp(BENCHMARK, root, { recursive: true })
  const readiness = await readFile(resolve(root, 'readiness.mjs'), 'utf8')
  assert.equal(readiness.split(SENTENCE).length, 2, 'the reworded readiness sentence must appear exactly once')
  await writeFile(resolve(root, 'readiness.mjs'), readiness.replace(SENTENCE, EARLIER))
  const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file =>
    [file, await readFile(resolve(root, file), 'utf8')])))
  return { root, sources, study: await import(pathToFileURL(resolve(root, 'study.mjs')).href),
    exporter: await import(pathToFileURL(resolve(root, 'export.mjs')).href) }
}
async function reHashed(project, change) {
  const forged = structuredClone(project)
  change(forged)
  const { sha256: staleReadiness, ...readinessBody } = forged.readiness
  forged.readiness.sha256 = await sha256(canonical(readinessBody))
  const { sha256: staleProject, ...projectBody } = forged
  forged.sha256 = await sha256(canonical(projectBody))
  return forged
}
// Re-point a manifest at a rewritten project.json, exactly as a forger would.
async function manifestFor(files, text, digest) {
  const manifest = JSON.parse(files['manifest.json'])
  manifest.projectSha256 = digest
  manifest.files['project.json'] = await sha256(text)
  return canonical(manifest) + '\n'
}

test('a project frozen by an earlier runtime is verified by the runtime it pins, not by this tree', async t => {
  const earlier = await earlierRuntime(t)
  const project = await earlier.study.freezeStudy(await earlier.study.bindRuntimeSources(draft(), earlier.sources))
  const files = await earlier.exporter.projectFiles(project, earlier.sources)
  const root = await scratch(t, 'earlier-project-')
  await write(root, files)

  // The premise, measured: this tree rebuilds the project differently, and the
  // difference is confined to the readiness contract the reworded file derives.
  const rebuilt = await freezeStudy(project.spec)
  assert.notEqual(rebuilt.sha256, project.sha256, 'premise: this tree rebuilds this project differently')
  assert.equal(canonical({ ...rebuilt, readiness: null, sha256: null }), canonical({ ...project, readiness: null, sha256: null }),
    'premise: only the derived readiness contract differs')
  assert.match(project.readiness.capabilities.requestedContext.scope, /earlier wording/)

  // The verdict, and whose it is.
  const opened = await openProject(root)
  assert.equal(opened.project.sha256, project.sha256, 'the pinned runtime verifies its own project')
  assert.equal(opened.runtime.isThisRuntime, false, 'this tree is not the runtime the project pins')
  assert.deepEqual(opened.runtime.differing, ['readiness.mjs'], 'the verdict names the file that moved')

  // The exported CLI, which IS the pinned runtime, and this tree's CLI, which
  // is not. Both accept the project. They must not claim the same thing about
  // it: only the pinned runtime can rebuild it, and this tree must say so
  // rather than borrow a verdict it did not reach.
  const receipts = []
  for (const entry of [resolve(root, 'cli.mjs'), resolve(fileURLToPath(BENCHMARK), 'cli.mjs')]) {
    const run = spawnSync(process.execPath, [entry, 'verify', '--project', root], { encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 })
    assert.equal(run.status, 0, run.stderr)
    const receipt = JSON.parse(run.stdout)
    assert.equal(receipt.ok, true)
    assert.equal(receipt.projectSha256, project.sha256)
    receipts.push(receipt)
  }
  const [pinnedReceipt, treeReceipt] = receipts
  assert.deepEqual(pinnedReceipt.runtime, { verifiedBy: 'this-runtime', filesDiffering: 0 },
    'the pinned runtime judges its own project and says so')
  assert.equal(treeReceipt.runtime.verifiedBy, 'project-digests')
  assert.equal(treeReceipt.runtime.filesDiffering, 1, 'and it names how many pinned files this tree does not carry')
  // The sentence is the whole point of the receipt: it tells a reader exactly
  // how much this verdict is worth and where to get the other one.
  assert.match(treeReceipt.runtime.note, /pinned runtime was not run/)
  assert.match(treeReceipt.runtime.note, /nothing from the archive was executed/)
  assert.match(treeReceipt.runtime.note, /run the project's cli\.mjs inside its directory/)
  // No readiness verdict is invented for a project this runtime did not freeze.
  // Re-deriving the contract here would report blockers the pinned runtime
  // never raised while still calling the project verified, which is a false
  // report and worse than the refusal it replaces.
  for (const operation of ['collect', 'diagnosticReplay', 'apparatusDevelopment'])
    assert.equal(treeReceipt.readiness[operation], null, operation + ': no verdict from a runtime that did not freeze this project')
  assert.deepEqual(treeReceipt.readiness.recorded, project.readiness,
    'the contract the project carries is reported as the data it is')
  assert.equal(pinnedReceipt.readiness.apparatusDevelopment.blockers.some(entry => entry.code === 'readiness-contract-missing-or-changed'), false,
    'premise: the runtime that derived this readiness contract does not fault it')

  // A substituted compiler cannot become the pinned one: the pins name the
  // original bytes, and the project that carries them is itself hashed.
  const substituted = earlier.sources['readiness.mjs'] + '\n// substituted\n'
  await writeFile(resolve(root, 'readiness.mjs'), substituted)
  await assert.rejects(readProject(root), /Frozen file changed/)
  const manifest = JSON.parse(files['manifest.json'])
  manifest.files['readiness.mjs'] = await sha256(substituted)
  await writeFile(resolve(root, 'manifest.json'), canonical(manifest) + '\n')
  await assert.rejects(readProject(root), /runtime source differs/)
  await writeFile(resolve(root, 'readiness.mjs'), earlier.sources['readiness.mjs'])
  await writeFile(resolve(root, 'manifest.json'), files['manifest.json'])
  assert.equal((await readProject(root)).sha256, project.sha256, 'control: the pinned bytes restored, the verdict returns')

  // The honest limit, stated rather than papered over. A forgery re-hashed all
  // the way through - project.json answering for its new contents and the
  // manifest agreeing - breaks no binding this process can check, because only
  // the compiler that froze the project could rebuild it and notice the
  // inserted blocker. This tree does not detect that, and the receipt does not
  // pretend otherwise: it says the pinned runtime was not run.
  const forged = await reHashed(project, value => { value.readiness.blockers = [{ code: 'forged', path: 'spec', message: 'Inserted after the freeze.' }] })
  const forgedText = canonical(forged) + '\n'
  await writeFile(resolve(root, 'project.json'), forgedText)
  await writeFile(resolve(root, 'manifest.json'), await manifestFor(files, forgedText, forged.sha256))
  const afterForgery = await openProject(root)
  assert.equal(afterForgery.project.sha256, forged.sha256, 'the digests still agree, so this tree still reads it')
  assert.equal(afterForgery.runtime.isThisRuntime, false)
  assert.equal(afterForgery.readiness, null, 'and it evaluates nothing, so the forged contract is never judged here')
  const treeOnForged = spawnSync(process.execPath, [resolve(fileURLToPath(BENCHMARK), 'cli.mjs'), 'verify', '--project', root],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 })
  assert.equal(treeOnForged.status, 0, 'this tree cannot tell: the forgery is internally consistent')
  assert.match(JSON.parse(treeOnForged.stdout).runtime.note, /pinned runtime was not run/,
    'so the receipt says what was not done, which is the only honest answer available here')
  // The runtime that CAN tell still does, when a person runs it where it lives.
  // That is what the receipt sends the reader to do.
  const pinnedOnForged = spawnSync(process.execPath, [resolve(root, 'cli.mjs'), 'verify', '--project', root],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 })
  assert.notEqual(pinnedOnForged.status, 0, 'the pinned runtime rebuilds and refuses the forgery')
  assert.match(pinnedOnForged.stderr, /frozen project changed/i)
})

test('a project that pins this tree is still judged by this tree, forgery and all', async t => {
  // The control for the case above. What separates the two is not the forgery:
  // it is which runtime the project pins. This project pins this tree, so this
  // tree's rebuild is the verdict, and a forged readiness contract is refused.
  const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file =>
    [file, await readFile(new URL(file, BENCHMARK), 'utf8')])))
  const project = await freezeStudy(await bindRuntimeSources(draft(), sources))
  const files = await projectFiles(project, sources)
  const root = await scratch(t, 'this-project-')
  await write(root, files)

  const opened = await openProject(root)
  assert.equal(opened.project.sha256, project.sha256)
  assert.deepEqual(opened.runtime, { isThisRuntime: true, differing: [] }, 'an export of this runtime pins this runtime, wherever it sits')

  const forged = await reHashed(project, value => { value.readiness.blockers = []; value.readiness.scientificBlockers = [] })
  const forgedText = canonical(forged) + '\n'
  await writeFile(resolve(root, 'project.json'), forgedText)
  await writeFile(resolve(root, 'manifest.json'), await manifestFor(files, forgedText, forged.sha256))
  await assert.rejects(readProject(root), /frozen project changed/)
})

// A foreign project is never rebuilt here, so verifyProject's shape check never
// runs on it. Every digest can agree while the file is still not a frozen
// project. Reading counts off it then failed with "Cannot read properties of
// undefined", which tells a reader nothing about their archive. The refusal has
// to be a sentence, and it has to be a refusal: reporting ok with null counts
// would claim more than was checked, which is the one thing this path exists to
// avoid.
test('a foreign project whose digests agree but whose shape does not is refused by name, not by a type error', async t => {
  const earlier = await earlierRuntime(t)
  const project = await earlier.study.freezeStudy(await earlier.study.bindRuntimeSources(draft(), earlier.sources))
  const files = await earlier.exporter.projectFiles(project, earlier.sources)
  const root = await scratch(t, 'shapeless-project-')
  await write(root, files)

  const shapeless = await reHashed(project, value => { delete value.tasks })
  const text = canonical(shapeless) + '\n'
  await writeFile(resolve(root, 'project.json'), text)
  await writeFile(resolve(root, 'manifest.json'), await manifestFor(files, text, shapeless.sha256))

  await assert.rejects(openProject(root), /does not declare its tasks and schedule/,
    'the reader refuses it by name rather than returning a project it cannot describe')
  const run = spawnSync(process.execPath, [resolve(fileURLToPath(BENCHMARK), 'cli.mjs'), 'verify', '--project', root],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 })
  assert.notEqual(run.status, 0, 'and the command fails rather than reporting ok about it')
  assert.match(run.stderr, /does not declare its tasks and schedule/)
  assert.doesNotMatch(run.stderr, /Cannot read properties/, 'a sentence, never a type error')
})
