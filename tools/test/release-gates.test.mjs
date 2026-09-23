import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir, stat, symlink, utimes } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_EVIDENCE,
  main,
  parseArgs,
  parseDistChain,
  planRun,
  readEvidence,
  selectGates,
  sourceBinding,
  artifactBinding,
  writeEvidence,
} from '../release-gates.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const REAL_DIST = JSON.parse(await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8')).scripts.dist

const CHAIN = [
  'npm run verify',
  'node tools/check-plain-language.mjs',
  'npm run build',
  'node tools/check-payload-boundary.mjs capability',
  'electron-builder --win nsis',
  'node tools/strip-build-diagnostics.mjs release',
  'node tools/check-no-owner-data.mjs release/win-unpacked',
  'node tools/seal-artifact.mjs --record release/win-unpacked',
  'node tools/check-payload-boundary.mjs release/win-unpacked/resources/capability',
  'node tools/seal-artifact.mjs --verify release/win-unpacked',
  'node tools/check-payload-boundary.mjs release/win-unpacked/resources/capability',
  'node tools/check-no-owner-data.mjs release',
].join(' && ')

test('the gate list is derived from scripts.dist, in order, with stable ids and no second copy', () => {
  const gates = parseDistChain(CHAIN)
  assert.deepEqual(gates.map(gate => gate.id), [
    'npm:verify',
    'check-plain-language',
    'npm:build',
    'check-payload-boundary:capability',
    'electron-builder',
    'strip-build-diagnostics:release',
    'check-no-owner-data:release/win-unpacked',
    'seal-artifact:--record release/win-unpacked',
    'check-payload-boundary:release/win-unpacked/resources/capability',
    'seal-artifact:--verify release/win-unpacked',
    'check-payload-boundary:release/win-unpacked/resources/capability#2',
    'check-no-owner-data:release',
  ])
  assert.deepEqual(gates.map(gate => gate.index), gates.map((_, index) => index))
})

test('producers are classified as producers and everything else as a check', () => {
  const byId = new Map(parseDistChain(CHAIN).map(gate => [gate.id, gate]))
  for (const id of ['npm:build', 'electron-builder', 'strip-build-diagnostics:release', 'seal-artifact:--record release/win-unpacked']) {
    assert.equal(byId.get(id).kind, 'producer', id)
  }
  for (const id of ['npm:verify', 'check-plain-language', 'check-no-owner-data:release', 'seal-artifact:--verify release/win-unpacked']) {
    assert.equal(byId.get(id).kind, 'check', id)
  }
})

test('a gate that names release/ binds to the artifact; the rest bind to the source tree', () => {
  const byId = new Map(parseDistChain(CHAIN).map(gate => [gate.id, gate]))
  assert.equal(byId.get('npm:verify').binding, 'source')
  assert.equal(byId.get('check-payload-boundary:capability').binding, 'source')
  assert.equal(byId.get('check-no-owner-data:release/win-unpacked').binding, 'artifact')
  assert.equal(byId.get('check-no-owner-data:release').binding, 'artifact')
})

test('the real scripts.dist parses, starts with the ratchet, and ends with the whole-release owner-data scan', () => {
  const gates = parseDistChain(REAL_DIST)
  assert.ok(gates.length >= 20, `expected the real chain to carry many gates, got ${gates.length}`)
  assert.equal(gates[0].id, 'npm:verify:release')
  assert.equal(gates[gates.length - 1].id, 'check-no-owner-data:release')
  assert.ok(gates.some(gate => gate.id === 'electron-builder' && gate.kind === 'producer'))
  const ids = gates.map(gate => gate.id)
  assert.equal(new Set(ids).size, ids.length, 'every gate id must be unique')
})

test('--gates-only keeps dist order, refuses unknown ids, and cannot be combined with --resume-from', () => {
  const gates = parseDistChain(CHAIN)
  const chosen = selectGates(gates, { gatesOnly: ['check-no-owner-data:release', 'npm:verify'] })
  assert.deepEqual(chosen.map(gate => gate.id), ['npm:verify', 'check-no-owner-data:release'])
  assert.throws(() => selectGates(gates, { gatesOnly: ['nope'] }), /unknown gate "nope"/)
  assert.throws(() => selectGates(gates, { gatesOnly: ['npm:verify'], resumeFrom: 'npm:build' }), /cannot be combined/)
})

test('--resume-from runs the named gate and everything after it', () => {
  const gates = parseDistChain(CHAIN)
  const chosen = selectGates(gates, { resumeFrom: 'check-no-owner-data:release/win-unpacked' })
  assert.deepEqual(chosen.map(gate => gate.id), [
    'check-no-owner-data:release/win-unpacked',
    'seal-artifact:--record release/win-unpacked',
    'check-payload-boundary:release/win-unpacked/resources/capability',
    'seal-artifact:--verify release/win-unpacked',
    'check-payload-boundary:release/win-unpacked/resources/capability#2',
    'check-no-owner-data:release',
  ])
  assert.throws(() => selectGates(gates, { resumeFrom: 'nope' }), /unknown gate/)
})

function passedEvidence(gate, binding, sourceBinding = 'HEAD-A') {
  return { ok: true, binding, sourceBinding, bindingKind: gate.binding, bindingVersion: 2,
    commandSha256: createHash('sha256').update(gate.command).digest('hex'),
    runtime: `${process.version}/${process.platform}/${process.arch}`, finishedAt: 't1' }
}

test('--skip-verified reuses only an identified static check, and never a producer or runtime test', () => {
  const gates = parseDistChain(`${CHAIN} && node tools/check-renderer-payload.mjs release/win-unpacked`)
  const bindings = { source: { digest: 'HEAD-A', clean: true }, artifact: { digest: 'ART-1', present: true } }
  const evidence = { version: 1, gates: Object.fromEntries(gates.map(gate => [gate.id, passedEvidence(gate, bindings[gate.binding].digest)])) }
  evidence.gates['check-plain-language'].binding = 'HEAD-OLD'
  evidence.gates['check-no-owner-data:release/win-unpacked'].ok = false
  delete evidence.gates['check-payload-boundary:capability']
  const plan = planRun(gates, { evidence, bindings, skipVerified: true })
  const action = id => plan.find(step => step.gate.id === id)
  assert.equal(action('npm:verify').action, 'run')
  assert.match(action('check-plain-language').reason, /inputs changed/)
  assert.equal(action('npm:build').action, 'run', 'a producer is never skipped')
  assert.match(action('npm:build').reason, /never skipped/)
  assert.match(action('check-no-owner-data:release/win-unpacked').reason, /last recorded run failed/)
  assert.equal(action('check-no-owner-data:release').action, 'run', 'private scanner configuration is outside a clean source commit')
  assert.equal(action('check-renderer-payload:release/win-unpacked').action, 'skip')
  assert.match(action('check-payload-boundary:capability').reason, /no evidence/)
})

test('--skip-verified never reuses a verdict against a dirty checker tree or an absent artifact', () => {
  const gates = parseDistChain('node tools/check-plain-language.mjs && node tools/check-renderer-payload.mjs release/win-unpacked')
  const evidence = { version: 1, gates: Object.fromEntries(gates.map(gate => [gate.id, passedEvidence(gate, gate.binding === 'source' ? 'HEAD-A' : 'ART-1')])) }
  const plan = planRun(gates, { evidence, bindings: { source: { digest: null, clean: false }, artifact: { digest: null, present: false } }, skipVerified: true })
  const action = id => plan.find(step => step.gate.id === id)
  assert.equal(action('check-plain-language').action, 'run')
  assert.match(action('check-plain-language').reason, /dirty/)
  assert.equal(action('check-renderer-payload:release/win-unpacked').action, 'run')
  assert.match(action('check-renderer-payload:release/win-unpacked').reason, /dirty/)
  const absent = planRun([gates[1]], { evidence, bindings: { source: { digest: 'HEAD-A', clean: true }, artifact: { digest: null } }, skipVerified: true })
  assert.match(absent[0].reason, /artifact absent/)
})

test('without --skip-verified every selected gate runs, evidence or not', () => {
  const gates = parseDistChain(CHAIN)
  const evidence = { version: 1, gates: { 'npm:verify': { ok: true, binding: 'HEAD-A' } } }
  const plan = planRun(gates, { evidence, bindings: { source: { digest: 'HEAD-A' }, artifact: { digest: 'ART-1' } }, skipVerified: false })
  assert.ok(plan.every(step => step.action === 'run'))
})

test('the source binding is the exact HEAD only when the tree is clean', () => {
  const clean = sourceBinding('/repo', { gitImpl: (args) => args[0] === 'rev-parse' ? 'abc123\n' : '' })
  assert.deepEqual({ ...clean }, { kind: 'source', head: 'abc123', clean: true, digest: 'abc123' })
  const dirty = sourceBinding('/repo', { gitImpl: (args) => args[0] === 'rev-parse' ? 'abc123\n' : ' M shell/x.cjs\n?? y\n' })
  assert.equal(dirty.clean, false)
  assert.equal(dirty.digest, null)
})

test('the artifact binding changes when a file inside release/win-unpacked changes size', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'release-gates-artifact-'))
  try {
    const artifact = path.join(repo, 'release', 'win-unpacked', 'resources')
    await mkdir(artifact, { recursive: true })
    await writeFile(path.join(artifact, 'app.asar'), 'one')
    const first = artifactBinding(repo)
    assert.equal(first.present, true)
    assert.equal(first.files, 1)
    await writeFile(path.join(artifact, 'app.asar'), 'one-two')
    const second = artifactBinding(repo)
    assert.notEqual(first.digest, second.digest)
    assert.equal(artifactBinding(path.join(repo, 'nowhere')).present, false)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('main runs the selected gates in order, records evidence, stops at the first failure, and names the resume point', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'release-gates-run-'))
  try {
    await writeFile(path.join(repo, 'package.json'), JSON.stringify({
      name: 'fixture',
      scripts: { dist: 'node -e "process.exit(0)" && node -e "process.exit(3)" && node -e "process.exit(0)"' },
    }))
    const lines = []
    const bindingsImpl = () => ({ source: { head: 'abc', clean: true, digest: 'abc' }, artifact: { present: false, digest: null } })
    const code = await main([], { repo, log: line => lines.push(line), bindingsImpl })
    assert.equal(code, 1)
    const evidence = readEvidence(path.join(repo, DEFAULT_EVIDENCE))
    const ids = Object.keys(evidence.gates)
    assert.equal(ids.length, 2, 'the third gate must not run after the second failed')
    assert.equal(evidence.gates[ids[0]].ok, true)
    assert.equal(evidence.gates[ids[1]].ok, false)
    assert.equal(evidence.gates[ids[1]].status, 3)
    assert.equal(evidence.gates[ids[0]].binding, null, 'unknown commands have no reusable input contract')
    assert.ok(lines.some(line => line.includes(`--resume-from ${ids[1]}`)), 'the stop line must name the resume point')
    const serialised = JSON.stringify(evidence)
    assert.equal(serialised.includes(repo), false, 'evidence must carry no absolute path')

    // Unknown commands run afresh; a failure is never reusable either.
    const again = []
    const code2 = await main(['--skip-verified', '--dry-run'], { repo, log: line => again.push(line), bindingsImpl })
    assert.equal(code2, 0)
    assert.ok(again.some(line => line.startsWith('[release-gates] RUN ') && line.includes(ids[0])))
    assert.ok(again.some(line => line.startsWith('[release-gates] RUN ') && line.includes(ids[1])))
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('--list prints every gate and the CLI refuses unknown flags', async () => {
  const lines = []
  const code = await main(['--list'], { repo: REPO_ROOT, log: line => lines.push(line) })
  assert.equal(code, 0)
  assert.ok(lines.some(line => /npm:verify:release$/.test(line)))
  assert.ok(lines.some(line => /producer .*electron-builder$/.test(line)))
  assert.throws(() => parseArgs(['--bogus']), /unrecognised argument/)
  assert.throws(() => parseArgs(['--resume-from']), /requires a value/)
})

test('the script runs from the command line and --dry-run touches nothing', () => {
  const script = path.join(REPO_ROOT, 'tools', 'release-gates.mjs')
  const result = spawnSync(process.execPath, [script, '--dry-run', '--gates-only', 'check-plain-language'], { cwd: REPO_ROOT, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /RUN {2}check-plain-language/)
})

test('Windows path casing cannot bypass the command-line gate', { skip: process.platform !== 'win32' }, () => {
  const script = path.join(REPO_ROOT, 'tools', 'release-gates.mjs').toUpperCase().replace(/\.MJS$/, '.mjs')
  const result = spawnSync(process.execPath, [script, '--not-a-real-flag'], { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 2, result.stdout + result.stderr)
  assert.match(result.stderr, /unrecognised argument/)
})

test('evidence round-trips and a foreign file is refused rather than trusted', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'release-gates-evidence-'))
  try {
    const file = path.join(dir, 'gate-evidence.json')
    writeEvidence(file, { version: 1, gates: { 'npm:verify': { ok: true, binding: 'x' } } })
    assert.deepEqual(readEvidence(file).gates['npm:verify'], { ok: true, binding: 'x' })
    await writeFile(file, JSON.stringify({ something: 'else' }))
    assert.throws(() => readEvidence(file), /not a gate evidence record/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('artifact bindings detect same-size edits with preserved mtimes and installer-only changes', async (t) => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'release-gates-content-'))
  t.after(() => rm(repo, { recursive: true, force: true }))
  const unpacked = path.join(repo, 'release', 'win-unpacked')
  await mkdir(unpacked, { recursive: true })
  const payload = path.join(unpacked, 'app.asar')
  await writeFile(payload, 'old')
  const installer = path.join(repo, 'release', 'Setup.exe')
  await writeFile(installer, 'installer')
  const before = artifactBinding(repo)
  const times = await stat(payload)
  await writeFile(payload, 'new')
  await utimes(payload, times.atime, times.mtime)
  assert.notEqual(artifactBinding(repo).digest, before.digest)
  const afterPayload = artifactBinding(repo)
  await writeFile(installer, 'different')
  assert.notEqual(artifactBinding(repo).digest, afterPayload.digest)
})

test('artifact binding leaves junctions uncacheable without following another tree', async (t) => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'release-gates-link-'))
  t.after(() => rm(repo, { recursive: true, force: true }))
  await mkdir(path.join(repo, 'release'))
  await mkdir(path.join(repo, 'target'))
  await symlink(path.join(repo, 'target'), path.join(repo, 'release', 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(artifactBinding(repo).digest, null)
  assert.match(artifactBinding(repo).reason, /linked artifact inputs/)
})

test('a producer invalidates a previously planned skip before the check executes', async (t) => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'release-gates-invalidation-'))
  t.after(() => rm(repo, { recursive: true, force: true }))
  await mkdir(path.join(repo, 'tools'))
  await mkdir(path.join(repo, 'release', 'win-unpacked'), { recursive: true })
  await writeFile(path.join(repo, 'release', 'win-unpacked', 'app.asar'), 'old')
  await writeFile(path.join(repo, 'tools', 'fixture-build.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('release/win-unpacked/app.asar', 'new')\n")
  await writeFile(path.join(repo, 'tools', 'check-renderer-payload.mjs'), "import { readFileSync } from 'node:fs'; process.exitCode = readFileSync('release/win-unpacked/app.asar', 'utf8') === 'old' ? 0 : 7\n")
  await writeFile(path.join(repo, 'package.json'), JSON.stringify({ scripts: { dist:
    'node tools/fixture-build.mjs && node tools/check-renderer-payload.mjs release/win-unpacked' } }))
  const evidenceFile = path.join(repo, DEFAULT_EVIDENCE)
  const bindingsImpl = () => ({ source: { head: 'HEAD-A', digest: 'HEAD-A', clean: true }, artifact: artifactBinding(repo, { exclude: [evidenceFile] }) })
  const check = 'check-renderer-payload:release/win-unpacked'
  assert.equal(await main(['--gates-only', check], { repo, bindingsImpl, log: () => {} }), 0)
  const lines = []
  assert.equal(await main(['--skip-verified'], { repo, bindingsImpl, log: line => lines.push(line) }), 1)
  assert.equal(readEvidence(evidenceFile).gates[check].status, 7, 'the changed artifact must actually reach the checker')
  assert.equal(lines.some(line => line.startsWith('[release-gates] SKIP') && line.includes(check)), false)
})

test('legacy evidence, changed check commands and runtime checks cannot be reused', () => {
  const [gate] = parseDistChain('node tools/check-plain-language.mjs')
  const bindings = { source: { clean: true, digest: 'HEAD-A' } }
  const evidence = { version: 1, gates: { [gate.id]: passedEvidence(gate, 'HEAD-A') } }
  assert.equal(planRun([gate], { evidence, bindings, skipVerified: true })[0].action, 'skip')
  delete evidence.gates[gate.id].bindingVersion
  assert.equal(planRun([gate], { evidence, bindings, skipVerified: true })[0].action, 'run')
  assert.equal(parseDistChain('node tools/new-build-step.mjs')[0].kind, 'producer')
  assert.equal(parseDistChain('node tools/require-clean-tree.mjs dist')[0].kind, 'producer')
  assert.equal(parseDistChain('node tools/check-plain-language.mjs --update')[0].reusable, false)
  assert.equal(parseDistChain('npm run verify:release')[0].reusable, false)
})
