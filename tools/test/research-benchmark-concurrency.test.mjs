import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { canonical, sha256 } from '../../src/benchmark/prompts.mjs'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { developmentStarter } from './fixtures/research-benchmark-development.mjs'
import { projectFiles } from '../../src/benchmark/export.mjs'
import { validateJournal } from '../../src/benchmark/runner.mjs'

const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file => [file, await readFile(new URL(`../../src/benchmark/${file}`, import.meta.url), 'utf8')])))
const adapter = `import { appendFile } from 'node:fs/promises'
export async function run(request) {
  await appendFile(new URL('./calls.jsonl', import.meta.url), JSON.stringify({ trialId: request.trial.id, attempt: request.attempt }) + '\\n')
  await new Promise(resolve => setTimeout(resolve, 200))
  return { output: '5' }
}`

async function exported(t, program = adapter) {
  const root = await mkdtemp(resolve(tmpdir(), 'benchmark-concurrency-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const spec = developmentStarter(); spec.tasks.length = 1; spec.protocol.maxAttemptsPerTrial = 2
  spec.conditions[0].adapter = { kind: 'module', file: 'adapter.mjs' }
  spec.inputs.push({ path: 'adapter.mjs', sha256: await sha256(program) })
  const project = await freezeStudy(await bindRuntimeSources(spec, sources))
  const files = await projectFiles(project, sources, { 'adapter.mjs': program })
  for (const [file, text] of Object.entries(files)) {
    await mkdir(dirname(resolve(root, file)), { recursive: true }); await writeFile(resolve(root, file), text)
  }
  // Each process imports the real exported CLI before joining the same start
  // boundary. The adapter is a local fixture; no provider is contacted.
  await writeFile(resolve(root, 'concurrent-cli.mjs'), `import { main } from './cli.mjs'
process.stdout.write('ready\\n')
await new Promise(resolve => process.stdin.once('data', resolve))
process.stdin.destroy()
try { await main(process.argv.slice(2)) } catch (error) { process.stderr.write(error.message + '\\n'); process.exitCode = 1 }
`)
  return { root, project }
}

async function concurrentRuns(root, output, recover, count = 12) {
  const ready = [], processes = []
  try {
    for (let i = 0; i < count; i++) {
      const child = spawn(process.execPath, [resolve(root, 'concurrent-cli.mjs'), 'run', '--compact', '--output', output, ...(recover ? ['--recover'] : [])], { stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      ready.push(new Promise((done, reject) => {
        let announced = false
        child.stdout.once('data', () => { announced = true; done() }); child.once('error', reject)
        child.once('close', code => { if (!announced) reject(new Error(`Concurrent CLI exited before its start boundary (${code}): ${stderr}`)) })
      }))
      child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
      processes.push({ child, finished: new Promise((done, reject) => { child.once('error', reject); child.once('close', code => done({ code, stdout, stderr })) }) })
    }
    await Promise.all(ready)
    for (const { child } of processes) child.stdin.end('start\n')
    return await Promise.all(processes.map(row => row.finished))
  } finally {
    for (const { child } of processes) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
}

const jsonLines = text => text.trim().split('\n').filter(Boolean).map(JSON.parse)
function deadOwner() {
  const child = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' })
  assert.equal(child.status, 0)
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' })
  return canonical({ pid: child.pid, startedAt: new Date().toISOString(), token: 'stale-test-owner' })
}

for (const recover of [false, true]) test(`simultaneous exported CLI ${recover ? 'recoveries' : 'runs'} dispatch each attempt once`, { timeout: 20000 }, async t => {
  const { root, project } = await exported(t)
  for (let round = 0; round < 4; round++) {
    const output = resolve(root, `results-${round}`)
    if (recover) {
      await mkdir(resolve(output, '.run-lock'), { recursive: true })
      await writeFile(resolve(output, '.run-lock/owner.json'), deadOwner())
      const trial = project.schedule[0]
      await writeFile(resolve(output, 'attempts.jsonl'), canonical({ type: 'started', seq: 1, projectSha256: project.sha256, readinessSha256: project.readiness.sha256, executionPurpose: 'apparatus-development', trialId: trial.id, attempt: 1, at: new Date().toISOString(), promptSha256: project.tasks[0].compiled.promptSha256 }) + '\n')
    }
    const results = await concurrentRuns(root, output, recover)
    assert.ok(results.some(result => result.code === 0), JSON.stringify(results))
    for (const result of results.filter(result => result.code !== 0)) assert.match(result.stderr, /holds \.recovery-lock|output directory is locked|recorded run process still exists/, result.stderr)
    const events = jsonLines(await readFile(resolve(output, 'attempts.jsonl'), 'utf8'))
    assert.deepEqual(validateJournal(project, events), [])
    assert.equal(events.filter(event => event.type === 'started').length, recover ? 2 : 1)
    assert.equal(events.filter(event => event.status === 'completed').length, 1)
    assert.equal(events.filter(event => event.status === 'interrupted').length, recover ? 1 : 0)
    const calls = jsonLines(await readFile(resolve(root, 'calls.jsonl'), 'utf8'))
    assert.equal(calls.length, round + 1, 'one actual adapter invocation per output directory')
    assert.equal(calls.at(-1).attempt, recover ? 2 : 1)
    await assert.rejects(readFile(resolve(output, '.run-lock/owner.json')), { code: 'ENOENT' })
    await assert.rejects(readFile(resolve(output, '.recovery-lock/owner.json')), { code: 'ENOENT' })
  }
})

test('an abandoned recovery gate refuses a new run even when the old run lock is absent', async t => {
  const { root } = await exported(t), output = resolve(root, 'results')
  await mkdir(resolve(output, '.recovery-lock'), { recursive: true })
  const owner = deadOwner()
  await writeFile(resolve(output, '.recovery-lock/owner.json'), owner)
  for (const recover of [false, true]) {
    const result = spawnSync(process.execPath, [resolve(root, 'cli.mjs'), 'run', ...(recover ? ['--recover'] : [])], { encoding: 'utf8', timeout: 5000 })
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /holds \.recovery-lock.*inspect/)
    assert.equal(await readFile(resolve(output, '.recovery-lock/owner.json'), 'utf8'), owner)
    await assert.rejects(readFile(resolve(root, 'calls.jsonl')), { code: 'ENOENT' })
    await assert.rejects(readFile(resolve(output, 'attempts.jsonl')), { code: 'ENOENT' })
  }
})

test('finishing a run preserves a replaced owner instead of deleting its lock', async t => {
  const { root } = await exported(t, `import { readFile, writeFile } from 'node:fs/promises'
export async function run() {
  const lock = new URL('./results/.run-lock/owner.json', import.meta.url)
  const owner = JSON.parse(await readFile(lock, 'utf8')); owner.token = 'replacement-owner'
  await writeFile(lock, JSON.stringify(owner))
  return { output: '5' }
}`)
  const result = spawnSync(process.execPath, [resolve(root, 'cli.mjs'), 'run'], { encoding: 'utf8', timeout: 5000 })
  assert.equal(result.status, 1, result.stderr); assert.match(result.stderr, /lock owner changed/)
  assert.equal(JSON.parse(await readFile(resolve(root, 'results/.run-lock/owner.json'), 'utf8')).token, 'replacement-owner')
  const events = jsonLines(await readFile(resolve(root, 'results/attempts.jsonl'), 'utf8'))
  assert.equal(events.filter(event => event.status === 'completed').length, 1)
})
