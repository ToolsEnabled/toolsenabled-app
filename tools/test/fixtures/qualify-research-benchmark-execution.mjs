// Controlled real LEAN callback qualification. No provider, personal review,
// study treatment choice or counted attempt is performed by this harness.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonical } from '../../../src/benchmark/prompts.mjs'
import { verifyNativeExecution } from '../../../src/benchmark/execution-lean.mjs'
import { QUALIFICATION_IMAGE, leanQualificationConfig, writeMinuteFixtures } from './qualify-research-benchmark-lean.mjs'

const source = fileURLToPath(new URL('../../../src/benchmark/', import.meta.url))
const json = value => JSON.stringify(value, null, 2) + '\n'
const hash = value => createHash('sha256').update(value).digest('hex')
async function command(binary, args, { input, timeout = 120000, acceptFailure = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
    child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const result = { binary, args, code, signal, stdout, stderr }
      if (code !== 0 && !acceptFailure) reject(Object.assign(new Error(binary + ' failed: ' + (stderr || stdout)), { result }))
      else resolvePromise(result)
    })
    child.stdin.end(input)
  })
}
async function hashes(root) {
  const result = {}
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) for (const [key, value] of Object.entries(await hashes(join(root, entry.name)))) result[entry.name + '/' + key] = value
    else result[entry.name] = hash(await readFile(join(root, entry.name)))
  }
  return result
}

export function executionFixture() {
  const at = index => 1704205860 + index * 60
  const config = { version: 1, cashCents: 100000, currency: 'USD', assets: [{ id: 'SPY', multiplier: 1, quantityStep: 1 }],
    owners: ['root/a', 'root/b'], limits: { intents: 20, events: 200 } }
  const intent = (id, owner, lotId, side, quantity, cashCapCents, bar) => ({ kind: 'intent',
    intent: { id, owner, lotId, asset: 'SPY', side, quantity, cashCapCents, reason: side === 'buy' ? 'entry' : 'exit', time: at(bar) } })
  const actions = [
    intent('a-buy', 'root/a', 'a-lot', 'buy', 4, 40000, 0),
    intent('b-buy', 'root/b', 'b-lot', 'buy', 4, 40000, 0),
    intent('cash-rejected', 'root/b', 'rejected-lot', 'buy', 3, 30000, 0),
    { kind: 'cancel', intentId: 'a-buy', time: at(3) },
    intent('a-exit', 'root/a', 'a-lot', 'sell', 2, 0, 4),
    intent('zero-buy', 'root/a', 'zero-lot', 'buy', 1, 10000, 7),
    { kind: 'cancel', intentId: 'zero-buy', time: at(8) },
  ]
  const fills = { 'a-buy': { [at(2)]: 2 }, 'b-buy': { [at(1)]: 2, [at(2)]: 2 }, 'a-exit': { [at(5)]: 1, [at(6)]: 1 } }
  return { config, actions, fills, input: { cashCents: config.cashCents, bars: Array.from({ length: 12 }, (_, i) => ({ time: new Date(at(i) * 1000).toISOString(), prices: { SPY: 10000 } })) } }
}

export async function qualifyExecution(directory, repeats = 3) {
  assert.ok(Number.isSafeInteger(repeats) && repeats >= 3 && repeats <= 20, 'Qualification requires 3–20 fresh native runs.')
  const root = resolve(directory)
  await mkdir(root, { recursive: false })
  const inspection = await command('docker', ['image', 'inspect', QUALIFICATION_IMAGE])
  await writeFile(join(root, 'image-inspect.json'), inspection.stdout)
  const metadata = join(root, 'metadata'), extraction = 'lean-execution-metadata-' + process.pid
  await mkdir(metadata)
  await command('docker', ['create', '--pull', 'never', '--name', extraction, '--network', 'none', QUALIFICATION_IMAGE])
  try { for (const folder of ['market-hours', 'symbol-properties']) await command('docker', ['cp', extraction + ':/Lean/Data/' + folder, metadata]) }
  finally { await command('docker', ['rm', '-f', extraction], { acceptFailure: true }) }
  const fixture = executionFixture()
  await writeFile(join(root, 'fixture.json'), json(fixture))
  const report = { kind: 'lean-private-execution-qualification', countedStudy: false, atomsApproved: false, status: 'running',
    image: QUALIFICATION_IMAGE, imageId: JSON.parse(inspection.stdout)[0].Id, fixtureSha256: hash(canonical(fixture)), metadataHashes: await hashes(metadata), runs: [] }
  const currentSources = async () => Object.fromEntries(await Promise.all(['execution.mjs', 'execution_reference.py', 'execution-lean.mjs', 'execution_lean.py'].map(async file => [file, hash(await readFile(join(source, file)))])))
  report.sourceHashes = await currentSources()
  await writeFile(join(root, 'qualification.json'), json(report))
  let previous
  try {
  for (let index = 1; index <= repeats; index++) {
    const run = join(root, 'run-' + index), algorithm = join(run, 'algorithm'), data = join(run, 'data'), results = join(run, 'results')
    for (const folder of [algorithm, data, results, join(data, 'market-hours'), join(data, 'symbol-properties')]) await mkdir(folder, { recursive: true })
    await cp(fileURLToPath(new URL('execution-lean-main.py', import.meta.url)), join(algorithm, 'main.py'))
    await cp(join(source, 'execution_reference.py'), join(algorithm, 'execution_reference.py'))
    await cp(join(source, 'execution_lean.py'), join(algorithm, 'execution_lean.py'))
    await writeFile(join(algorithm, 'fixture.json'), json(fixture))
    await writeMinuteFixtures(data, fixture.input)
    const id = 'execution-' + index, config = join(run, 'config.json'), name = 'lean-execution-' + process.pid + '-' + index
    await writeFile(config, json(leanQualificationConfig(id)))
    const args = ['run', '--pull', 'never', '--rm', '--name', name, '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '512', '--memory', '2g', '--cpus', '2', '--read-only', '--tmpfs', '/tmp:rw,size=256m', '-e', 'PYTHONDONTWRITEBYTECODE=1', '-e', 'MPLCONFIGDIR=/tmp/matplotlib',
      '--mount', 'type=bind,source=' + algorithm + ',target=/Algorithm,readonly', '--mount', 'type=bind,source=' + data + ',target=/Data,readonly',
      '--mount', 'type=bind,source=' + join(metadata, 'market-hours') + ',target=/Data/market-hours,readonly',
      '--mount', 'type=bind,source=' + join(metadata, 'symbol-properties') + ',target=/Data/symbol-properties,readonly',
      '--mount', 'type=bind,source=' + results + ',target=/Results', '--mount', 'type=bind,source=' + config + ',target=/Config/config.json,readonly',
      QUALIFICATION_IMAGE, '--config', '/Config/config.json']
    console.log('Running pinned LEAN execution fixture ' + index)
    let execution
    try { execution = await command('docker', args, { acceptFailure: true }) }
    finally {
      const removed = await command('docker', ['rm', '-f', name], { acceptFailure: true })
      assert.ok(removed.code === 0 || /No such (container|object)/i.test(removed.stderr), 'Could not remove the owned execution container.')
      const inspected = await command('docker', ['inspect', '--type', 'container', name], { acceptFailure: true })
      assert.ok(inspected.code !== 0 && /No such (container|object)/i.test(inspected.stderr), 'The owned execution container remains or removal is unverified.')
    }
    await writeFile(join(run, 'execution.json'), json(execution))
    await writeFile(join(run, 'stdout.log'), execution.stdout); await writeFile(join(run, 'stderr.log'), execution.stderr)
    assert.equal(execution.code, 0, 'Inspect ' + run + '/stdout.log')
    const result = JSON.parse(await readFile(join(results, id + '.json'))), events = JSON.parse(await readFile(join(results, id + '-order-events.json')))
    assert.equal(result.state.Status, 'Completed', JSON.stringify(result.state))
    const python = JSON.parse(await readFile(join(results, 'execution-snapshot.json')))
    const actual = verifyNativeExecution({ config: fixture.config, result, events, journal: python.journal, actions: fixture.actions })
    assert.deepEqual(actual, python, 'Independent JavaScript and actual Python callback state differ')
    assert.equal(actual.cashCents, 60000); assert.equal(actual.reservedCashCents, 0)
    assert.deepEqual(actual.positions, [{ asset: 'SPY', quantity: 4 }])
    assert.equal(actual.lots.find(lot => lot.id === 'a-lot').roundTripComplete, true)
    assert.equal(actual.lots.find(lot => lot.id === 'b-lot').quantity, 4)
    assert.equal(actual.lots.find(lot => lot.id === 'zero-lot').roundTripComplete, false)
    assert.equal(actual.decisions.find(row => row.intent.id === 'cash-rejected').admitted, false)
    assert.equal(actual.events.filter(row => row.kind === 'fill').length, 5)
    assert.deepEqual(actual.tickets.map(row => row.status), ['cancelled', 'filled', 'filled', 'cancelled'])
    const expectedFills = Object.entries(fixture.fills).flatMap(([intentId, fills]) => Object.entries(fills).map(([time, quantity]) => ({ intentId, time: Number(time), quantity }))).sort((a, b) => a.time - b.time || a.intentId.localeCompare(b.intentId))
    const actualFills = actual.events.filter(row => row.kind === 'fill').map(({ intentId, time, quantity }) => ({ intentId, time, quantity })).sort((a, b) => a.time - b.time || a.intentId.localeCompare(b.intentId))
    assert.deepEqual(actualFills, expectedFills, 'Actual native fills differ from the independent fixture schedule')
    if (previous) assert.deepEqual(actual, previous, 'Fresh native runs differ')
    previous = actual
    await writeFile(join(run, 'verified-execution.json'), json(actual))
    report.runs.push({ id, status: 'passed', sourceHashes: await hashes(algorithm), dataHashes: await hashes(data), resultHashes: await hashes(results), observationSha256: hash(canonical(actual)), fills: actualFills.length })
    await writeFile(join(root, 'qualification.json'), json(report))
  }
  assert.deepEqual(await currentSources(), report.sourceHashes, 'Execution sources changed during native qualification.')
  report.status = 'passed'
  report.ownedContainersRemoved = true
  } catch (error) {
    report.status = 'failed'; report.error = error.message
    await writeFile(join(root, 'qualification.json'), json(report))
    throw error
  }
  await writeFile(join(root, 'qualification.json'), json(report))
  console.log(json(report))
  return report
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Pass a new evidence directory for real local Docker backtests.')
  await qualifyExecution(process.argv[2], Number(process.argv[3] || 3))
}
