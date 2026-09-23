// Study identity: the machine-readable identifier and the investigator's own
// study version are separate fields with separate rules.
//
// Why a version field exists at all. A citation of a research artefact has to
// name the exact release it refers to, and that release label has to order:
// Smith, Katz, Niemeyer and the FORCE11 Software Citation Working Group,
// "Software Citation Principles", PeerJ Computer Science 2:e86 (2016),
// doi:10.7717/peerj-cs.86, its Unique Identification and Specificity
// principles. A slug that a filesystem and npm accept cannot carry dots,
// so the two cannot be the same string.
//
// Why the syntax is Semantic Versioning 2.0.0 (Preston-Werner,
// https://semver.org/spec/v2.0.0.html): the exported package.json "version"
// must be a valid SemVer for npm to read the project at all, so the page has
// to refuse anything npm would refuse, at the moment it is typed.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { bindRuntimeSources, freezeStudy, identifierProblem, normalizeStudyVersion,
  RUNTIME_FILES, STUDY_VERSION_RULES, studyVersionProblem, validateStudy } from '../../src/benchmark/study.mjs'
import { projectFiles } from '../../src/benchmark/export.mjs'
import { researchReportFiles } from '../../src/benchmark/report.mjs'
import { genericStarter } from '../../src/benchmark/starters.mjs'
import { newExperimentDraft } from '../../src/benchmark/starters.mjs'

const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async name => [name, await readFile(new URL('../../src/benchmark/' + name, import.meta.url), 'utf8')])))
// purpose selects the execution plan. The report test renders front matter
// only, so it runs an apparatus-development project: a generic starter has no
// registered composition coverage or independent interpreters, and asking the
// runner to admit it as an experiment would be claiming a qualification this
// draft does not have.
function study(version, purpose = 'experiment') {
  const spec = newExperimentDraft(genericStarter(), { purpose })
  spec.name = 'Lean Bench 1.0.44'; spec.id = 'lean-bench-1-0-44'
  spec.analysisPlan.primaryPopulation = 'all'
  if (version !== undefined) spec.version = version
  return spec
}
const frozen = async spec => freezeStudy(await bindRuntimeSources(spec, sources))
async function exported(t, project) {
  const root = await mkdtemp(resolve(tmpdir(), 'research-study-version-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const files = await projectFiles(project, sources)
  for (const [file, text] of Object.entries(files)) { await mkdir(dirname(resolve(root, file)), { recursive: true }); await writeFile(resolve(root, file), text) }
  return { root, files }
}
const cli = (root, ...args) => spawnSync(process.execPath, [resolve(root, 'cli.mjs'), ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

const ticking = () => { let clock = 1700000000000; return () => (clock += 250) }

test('the identifier refusal names the dot as the reason and offers the hyphenated form', () => {
  // HT-2: at 370ac601 every bad identifier produced one sentence, "Give the
  // benchmark a name and a lowercase identifier.", which never said that the
  // dots in lean-bench-1.0.44 were the reason.
  assert.equal(identifierProblem('lean-bench-1-0-44'), null)
  const dotted = identifierProblem('lean-bench-1.0.44')
  assert.match(dotted, /dot/i)
  assert.match(dotted, /lean-bench-1-0-44/)
  assert.match(dotted, /[Ss]tudy version/)
  assert.match(identifierProblem('Lean-Bench'), /lowercase/i)
  assert.match(identifierProblem('Lean-Bench'), /lean-bench/)
  assert.match(identifierProblem('1-lean-bench'), /start/i)
  assert.match(identifierProblem('lean bench'), /space/i)
  assert.match(identifierProblem('lean$bench'), /\$/)
  assert.match(identifierProblem('a'.repeat(65)), /64/)
  assert.match(identifierProblem('   '), /identifier/i)
  // The name is refused on its own sentence, so neither refusal hides the other.
  const spec = study(); spec.name = '   '
  assert.throws(() => validateStudy(spec), /Give the benchmark a name\./)
  const bad = study(); bad.id = 'lean-bench-1.0.44'
  assert.throws(() => validateStudy(bad), /dot/i)
})

test('the study version normalizes by stated rules and .44 reads as a decimal', () => {
  assert.equal(normalizeStudyVersion('1.0.44'), '1.0.44')
  assert.equal(normalizeStudyVersion('  1.0.44  '), '1.0.44')
  assert.equal(normalizeStudyVersion('v1.0.44'), '1.0.44')
  assert.equal(normalizeStudyVersion('V1.0.44'), '1.0.44')
  // A leading dot is a decimal elision of zero, as .44 means 0.44 everywhere
  // else, and the completed form is shown to the investigator before freezing.
  assert.equal(normalizeStudyVersion('.44'), '0.44.0')
  assert.equal(normalizeStudyVersion('44'), '44.0.0')
  assert.equal(normalizeStudyVersion('1.0'), '1.0.0')
  assert.equal(normalizeStudyVersion('1.0.44-rc.1'), '1.0.44-rc.1')
  assert.equal(normalizeStudyVersion('1.0.44+rt.301e565e445f'), '1.0.44+rt.301e565e445f')
  assert.equal(normalizeStudyVersion(''), undefined)
  assert.equal(normalizeStudyVersion('   '), undefined)
  assert.equal(normalizeStudyVersion(undefined), undefined)
  // Normalizing is idempotent, so the stored form never drifts on a reload.
  for (const raw of ['1.0.44', '.44', 'v2', '1.0.44-rc.1']) assert.equal(normalizeStudyVersion(normalizeStudyVersion(raw)), normalizeStudyVersion(raw))
  // The rules the page shows are the rules this function applies.
  assert.ok(STUDY_VERSION_RULES.length >= 4 && STUDY_VERSION_RULES.every(rule => typeof rule === 'string' && rule.trim()))
  assert.ok(STUDY_VERSION_RULES.some(rule => rule.includes('.44')))
})

test('a refused study version says which rule it broke', () => {
  assert.equal(studyVersionProblem('1.0.44'), null)
  assert.match(studyVersionProblem('1.0.44.2'), /three numbers|MAJOR\.MINOR\.PATCH/)
  assert.match(studyVersionProblem('1.0.44.2'), /1\.0\.44\.2/)
  assert.match(studyVersionProblem('01.0.44'), /leading zero|start with a zero/i)
  assert.match(studyVersionProblem('1.0.x'), /MAJOR\.MINOR\.PATCH/)
  assert.match(studyVersionProblem('1.0.44 beta'), /space/i)
  assert.match(studyVersionProblem(''), /version/i)
})

import { runStudy } from '../../src/benchmark/runner.mjs'

test('the frozen spec keeps the declared version and refuses an unnormalized or misplaced one', async () => {
  const project = await frozen(study('1.0.44'))
  assert.equal(project.spec.version, '1.0.44')
  // The frozen artefact holds the completed form, never the raw keystrokes.
  assert.throws(() => validateStudy(study(' 1.0.44 ')), /normalized|1\.0\.44/)
  assert.throws(() => validateStudy(study('.44')), /normalized|0\.44\.0/)
  assert.throws(() => validateStudy(study('1.0.44.2')), /three numbers|MAJOR\.MINOR\.PATCH/)
  // Version 1 studies are historical artefacts and gain no new field.
  const legacy = genericStarter(); legacy.version = '1.0.44'
  assert.throws(() => validateStudy(legacy), /version 2 study/)
  // An undeclared version stays undeclared rather than becoming a default.
  assert.equal((await frozen(study())).spec.version, undefined)
})

test('the exported package.json carries the study version, and 1.0.0 only when none is declared', async (t) => {
  const declared = await exported(t, await frozen(study('1.0.44')))
  const pkg = JSON.parse(declared.files['package.json'])
  assert.equal(pkg.version, '1.0.44')
  assert.equal(pkg.name, 'lean-bench-1-0-44')
  const lock = JSON.parse(declared.files['package-lock.json'])
  assert.equal(lock.version, '1.0.44'); assert.equal(lock.packages[''].version, '1.0.44')
  assert.match(declared.files['README.md'], /^# Lean Bench 1\.0\.44\n/)
  assert.match(declared.files['README.md'], /Study version: 1\.0\.44/)

  // HT-3 said the exported package.json is always 1.0.0. That stays true, and
  // stays byte-identical, exactly when the investigator declared no version.
  const plain = await exported(t, await frozen(study()))
  assert.equal(JSON.parse(plain.files['package.json']).version, '1.0.0')
  assert.equal(JSON.parse(plain.files['package-lock.json']).version, '1.0.0')
  assert.ok(!plain.files['README.md'].includes('Study version:'))
})

test('the report front matter states the study version, or that none was declared', async () => {
  const project = await frozen(study('1.0.44', 'apparatus-development'))
  const run = await runStudy(project, { now: ticking() })
  const files = await researchReportFiles(project, run.events)
  // report.md escapes Markdown punctuation (report.mjs md()), so the cell
  // reads 1\.0\.44. Assert the bytes the report actually writes, and assert
  // the HTML report separately so the version is shown in both renderings.
  assert.ok(files['report.md'].includes('| Study version | 1\\.0\\.44 |'), files['report.md'].slice(0, 400))
  assert.ok(files['report.md'].includes('| Study identifier | lean-bench-1-0-44 |'))
  assert.ok(files['report.html'].includes('<td>Study version</td><td>1.0.44</td>')
    || /Study version<\/t[dh]>\s*<t[dh]>1\.0\.44/.test(files['report.html']), 'report.html has no Study version cell')

  const bare = await frozen(study(undefined, 'apparatus-development'))
  const bareRun = await runStudy(bare, { now: ticking() })
  const bareFiles = await researchReportFiles(bare, bareRun.events)
  assert.ok(bareFiles['report.md'].includes('| Study version | Not declared |'))
})

test('node cli.mjs verify reports the study version of the project it read', async (t) => {
  const { root } = await exported(t, await frozen(study('1.0.44')))
  const declared = cli(root, 'verify')
  assert.equal(declared.status, 0, declared.stderr)
  assert.equal(JSON.parse(declared.stdout).studyVersion, '1.0.44')

  const { root: bareRoot } = await exported(t, await frozen(study()))
  const bare = cli(bareRoot, 'verify')
  assert.equal(bare.status, 0, bare.stderr)
  assert.equal(JSON.parse(bare.stdout).studyVersion, null)
})
