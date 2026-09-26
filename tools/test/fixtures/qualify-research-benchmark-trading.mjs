// Trusted-reference native qualification of the full operational controller.
// Synthetic policies are draft fixtures, never personal approval or a study run.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonical } from '../../../src/benchmark/prompts.mjs'
import { generateOperationalLeanProgram, inlineOperationalLeanProgram, verifyNativeTradingReference } from '../../../src/benchmark/trading-lean.mjs'
import { strategy, template, tradingCase } from './trading-operational-cases.mjs'
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

export async function operationalFixture() {
  const at = index => 1704205860 + index * 60
  const leaf = () => strategy({ buy_reason: { kind: 'above', value: 5000 }, buy_process: { kind: 'shares', quantity: 4, cashCapCents: 40000 } })
  const root = template('all', [
    template('race', [leaf(), leaf()], { policy: { claim: 'first-fill', release: 'empty-or-complete-next-bar', losers: 'cancel-then-liquidate' } }),
    template('sequence', [leaf(), leaf()]),
  ], { reset: { predicate: { kind: 'below', asset: 'GATE', value: 3 }, trigger: 'rising-edge' } })
  const compiled = await tradingCase(root, { cashCents: 150000 })
  const bars = Array.from({ length: 8 }, (_, index) => ({ time: at(index), prices: { SPY: 10000, GATE: index >= 6 ? 1 : 10 } }))
  const fills = {
    'n2:buy:entry': { [at(1)]: 2, [at(2)]: 2 }, 'n3:buy:entry': { [at(1)]: 1 }, 'n5:buy:entry': { [at(1)]: 4 },
    'n3:sell:race-release': { [at(3)]: 1 }, 'n2:sell:exit': { [at(4)]: 2, [at(5)]: 2 }, 'n5:sell:exit': { [at(3)]: 4 },
    'n6:buy:entry': { [at(5)]: 2 }, 'n6:sell:reset': { [at(7)]: 2 },
  }
  return { ...compiled, bars, fills, input: { cashCents: compiled.config.cashCents,
    bars: bars.map(bar => ({ ...bar, time: new Date(bar.time * 1000).toISOString() })) } }
}

export async function qualifyOperational(directory, repeats = 3, { inline = false } = {}) {
  assert.ok(Number.isSafeInteger(repeats) && repeats >= 3 && repeats <= 20)
  const root = resolve(directory)
  await mkdir(root, { recursive: false })
  const inspection = await command('docker', ['image', 'inspect', QUALIFICATION_IMAGE])
  await writeFile(join(root, 'image-inspect.json'), inspection.stdout)
  const metadata = join(root, 'metadata'), extraction = 'lean-operational-metadata-' + process.pid
  await mkdir(metadata)
  await command('docker', ['create', '--pull', 'never', '--name', extraction, '--network', 'none', QUALIFICATION_IMAGE])
  try { for (const folder of ['market-hours', 'symbol-properties']) await command('docker', ['cp', extraction + ':/Lean/Data/' + folder, metadata]) }
  finally { await command('docker', ['rm', '-f', extraction], { acceptFailure: true }) }
  const files = ['prompts.mjs', 'composition.mjs', 'execution.mjs', 'execution_reference.py', 'execution-lean.mjs', 'execution_lean.py',
    'trading-ir.mjs', 'trading-runtime.mjs', 'trading_reference.py', 'trading-lean.mjs', 'trading_lean.py']
  const sources = Object.fromEntries(await Promise.all(files.map(async file => [file, await readFile(join(source, file), 'utf8')])))
  const fixture = await operationalFixture()
  await writeFile(join(root, 'fixture.json'), json(fixture))
  const report = { kind: 'lean-operational-reference-qualification', countedStudy: false, atomsApproved: false, status: 'running',
    packaging: inline ? 'self-contained-python' : 'python-modules',
    image: QUALIFICATION_IMAGE, imageId: JSON.parse(inspection.stdout)[0].Id, fixtureSha256: hash(canonical(fixture)),
    sourceHashes: Object.fromEntries(files.map(file => [file, hash(sources[file])])), metadataHashes: await hashes(metadata), runs: [] }
  await writeFile(join(root, 'qualification.json'), json(report))
  let previous
  try {
    for (let index = 1; index <= repeats; index++) {
      const run = join(root, 'run-' + index), algorithm = join(run, 'algorithm'), data = join(run, 'data'), results = join(run, 'results')
      for (const directory of [algorithm, data, results, join(data, 'market-hours'), join(data, 'symbol-properties')]) await mkdir(directory, { recursive: true })
      await cp(fileURLToPath(new URL('trading-lean-main.py', import.meta.url)), join(algorithm, 'main.py'))
      const generated = generateOperationalLeanProgram(fixture.ir, fixture.bars, sources)
      await writeFile(join(algorithm, 'generated.py'), inline ? inlineOperationalLeanProgram(generated, sources) : generated)
      if (!inline) for (const file of ['execution_reference.py', 'execution_lean.py', 'trading_reference.py']) await writeFile(join(algorithm, file), sources[file])
      await writeFile(join(algorithm, 'fixture.json'), json(fixture))
      await writeMinuteFixtures(data, fixture.input)
      const id = 'operational-' + index, config = join(run, 'config.json'), name = 'lean-operational-' + process.pid + '-' + index
      await writeFile(config, json(leanQualificationConfig(id)))
      const args = ['run', '--pull', 'never', '--rm', '--name', name, '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '512', '--memory', '2g', '--cpus', '2', '--read-only', '--tmpfs', '/tmp:rw,size=256m', '-e', 'PYTHONDONTWRITEBYTECODE=1', '-e', 'MPLCONFIGDIR=/tmp/matplotlib',
        '--mount', 'type=bind,source=' + algorithm + ',target=/Algorithm,readonly', '--mount', 'type=bind,source=' + data + ',target=/Data,readonly',
        '--mount', 'type=bind,source=' + join(metadata, 'market-hours') + ',target=/Data/market-hours,readonly',
        '--mount', 'type=bind,source=' + join(metadata, 'symbol-properties') + ',target=/Data/symbol-properties,readonly',
        '--mount', 'type=bind,source=' + results + ',target=/Results', '--mount', 'type=bind,source=' + config + ',target=/Config/config.json,readonly',
        QUALIFICATION_IMAGE, '--config', '/Config/config.json']
      console.log('Qualifying operational lifecycle in pinned LEAN, fresh run ' + index)
      let execution
      try { execution = await command('docker', args, { acceptFailure: true }) }
      finally {
        const removed = await command('docker', ['rm', '-f', name], { acceptFailure: true })
        assert.ok(removed.code === 0 || /No such (container|object)/i.test(removed.stderr), 'Owned native container removal failed')
        const absent = await command('docker', ['inspect', '--type', 'container', name], { acceptFailure: true })
        assert.ok(absent.code !== 0 && /No such (container|object)/i.test(absent.stderr), 'Owned container still exists or removal is unverified')
        await writeFile(join(run, 'cleanup.json'), json({ removed, absent }))
      }
      await writeFile(join(run, 'execution.json'), json(execution))
      await writeFile(join(run, 'stdout.log'), execution.stdout); await writeFile(join(run, 'stderr.log'), execution.stderr)
      assert.equal(execution.code, 0, 'Inspect retained native output at ' + run)
      const result = JSON.parse(await readFile(join(results, id + '.json'))), events = JSON.parse(await readFile(join(results, id + '-order-events.json')))
      assert.equal(result.state.Status, 'Completed', JSON.stringify(result.state))
      const snapshot = JSON.parse(await readFile(join(results, 'operational-snapshot.json')))
      const checked = verifyNativeTradingReference({ ir: fixture.ir, bars: fixture.bars, result, events, snapshot })
      const independent = await command('python3', [join(source, 'trading_reference.py')], { input: canonical({ ir: fixture.ir, actions: checked.actions }) })
      await writeFile(join(run, 'independent-python.json'), json(independent))
      assert.deepEqual(JSON.parse(independent.stdout).snapshot, snapshot)
      const expectedFills = Object.entries(fixture.fills).flatMap(([key, fills]) => Object.entries(fills).map(([time, quantity]) => ({ key, time: Number(time), quantity })))
        .sort((a, b) => a.time - b.time || a.key.localeCompare(b.key))
      const tickets = new Map(snapshot.ledger.tickets.map(ticket => [ticket.id, ticket]))
      const actualFills = snapshot.ledger.events.filter(row => row.kind === 'fill').map(row => {
        const ticket = tickets.get(row.intentId)
        return { key: [ticket.owner, ticket.side, ticket.reason].join(':'), time: row.time, quantity: row.quantity }
      }).sort((a, b) => a.time - b.time || a.key.localeCompare(b.key))
      assert.deepEqual(actualFills, expectedFills, 'Real fills differ from the independent boundary table')
      assert.equal(snapshot.ledger.cashCents, 150000); assert.equal(snapshot.ledger.reservedCashCents, 0)
      assert.ok(snapshot.ledger.positions.every(row => row.quantity === 0))
      assert.deepEqual(snapshot.states.map(row => row.generation), [1, 1, 1, 2, 1, 1, 1], 'The losing branch clears once for RACE and again for the root reset')
      assert.ok(snapshot.states.every(row => !row.active && !row.pending && !row.completedRoundTrip))
      assert.ok(snapshot.transitions.some(row => row.kind === 'race-released' && row.cause === 'completed-roundtrip'))
      assert.ok(snapshot.transitions.some(row => row.kind === 'sequence-advanced'))
      if (previous) assert.deepEqual(snapshot, previous, 'Fresh native lifecycle observations differ')
      previous = snapshot
      await writeFile(join(run, 'verified-operational.json'), json(checked))
      report.runs.push({ id, status: 'passed', sourceHashes: await hashes(algorithm), dataHashes: await hashes(data), resultHashes: await hashes(results),
        observationSha256: hash(canonical(snapshot)), fills: actualFills.length, controllers: snapshot.states.length })
      await writeFile(join(root, 'qualification.json'), json(report))
    }
    assert.deepEqual(Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(join(source, file)))]))), report.sourceHashes, 'Operational sources changed during qualification')
    report.status = 'passed'; report.ownedContainersRemoved = true
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
  if (!process.argv[2]) throw new Error('Pass a new native qualification evidence directory')
  if (process.argv[4] && process.argv[4] !== 'inline') throw new Error('The optional packaging argument is inline')
  await qualifyOperational(process.argv[2], Number(process.argv[3] || 3), { inline: process.argv[4] === 'inline' })
}
