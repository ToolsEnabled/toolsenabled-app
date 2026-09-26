// Real-engine apparatus qualification. This never approves draft atoms or runs a counted study.
// Usage: node tools/test/fixtures/qualify-research-benchmark-lean.mjs /absolute/evidence/directory
// Pull the exact image below separately; this harness never pulls a floating tag.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile, copyFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonical, compilePrompt } from '../../../src/benchmark/prompts.mjs'
import { leanCatalog, interpretLean } from '../../../src/benchmark/lean.mjs'
import { qualificationFixtures } from '../../../src/benchmark/lean-cases.mjs'
export { qualificationFixtures } from '../../../src/benchmark/lean-cases.mjs'
import { generateLeanProgram } from '../../../src/benchmark/lean-codegen.mjs'
import { normalizeOrderEvents } from '../../../src/benchmark/lean-grade.mjs'

export const QUALIFICATION_IMAGE = 'quantconnect/lean@sha256:cc27d5608d209fc9276c8419af3dd8e598ba49075c6f5c44ca38bf637eaef216'
const sourceRoot = fileURLToPath(new URL('../../../src/benchmark/', import.meta.url))
const hash = value => createHash('sha256').update(value).digest('hex')
const json = value => JSON.stringify(value, null, 2) + '\n'

async function command(binary, args, { timeout = 120000, input, acceptFailure = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const result = { binary, args, code, signal, stdout, stderr }
      if (code !== 0 && !acceptFailure) reject(Object.assign(new Error(`${binary} exited ${code}: ${stderr || stdout}`), { result }))
      else resolvePromise(result)
    })
    child.stdin.end(input)
  })
}

export function leanQualificationConfig(id = 'fixture') {
  return {
    environment: 'backtesting', 'algorithm-type-name': 'FrozenBenchmark', 'algorithm-language': 'Python',
    'algorithm-location': '/Algorithm/main.py', 'algorithm-id': id, 'data-folder': '/Data',
    'results-destination-folder': '/Results', 'log-file-name': '/Results/engine.log',
    'debugging': false, 'debug-mode': false, 'close-automatically': true,
    'log-handler': 'QuantConnect.Logging.CompositeLogHandler', 'messaging-handler': 'QuantConnect.Messaging.Messaging',
    'job-queue-handler': 'QuantConnect.Queues.JobQueue', 'api-handler': 'QuantConnect.Api.Api',
    'map-file-provider': 'QuantConnect.Data.Auxiliary.LocalDiskMapFileProvider',
    'factor-file-provider': 'QuantConnect.Data.Auxiliary.LocalDiskFactorFileProvider',
    'data-provider': 'QuantConnect.Lean.Engine.DataFeeds.DefaultDataProvider', 'data-channel-provider': 'DataChannelProvider',
    'object-store': 'QuantConnect.Lean.Engine.Storage.LocalObjectStore', 'object-store-root': '/Results/storage',
    'data-aggregator': 'QuantConnect.Lean.Engine.DataFeeds.AggregationManager',
    'job-user-id': '0', 'api-access-token': '', 'job-organization-id': '',
    'python-additional-paths': ['/Algorithm'], 'show-missing-data-logs': true,
    'environments': { backtesting: {
      'live-mode': false, 'setup-handler': 'QuantConnect.Lean.Engine.Setup.BacktestingSetupHandler',
      'result-handler': 'QuantConnect.Lean.Engine.Results.BacktestingResultHandler',
      'data-feed-handler': 'QuantConnect.Lean.Engine.DataFeeds.FileSystemDataFeed',
      'real-time-handler': 'QuantConnect.Lean.Engine.RealTime.BacktestingRealTimeHandler',
      'history-provider': ['QuantConnect.Lean.Engine.HistoricalData.SubscriptionDataReaderHistoryProvider'],
      'transaction-handler': 'QuantConnect.Lean.Engine.TransactionHandlers.BacktestingTransactionHandler',
    } },
  }
}

// Timestamps in LEAN equity minute files name bar starts in New York local time;
// task timestamps name completed bars in UTC. ZIP member timestamps are fixed.
export async function writeMinuteFixtures(dataDirectory, input) {
  await mkdir(dataDirectory, { recursive: true })
  await command('python3', ['-c', `import json,sys,zipfile
from pathlib import Path
from datetime import datetime,timedelta
from zoneinfo import ZoneInfo
root=Path(sys.argv[1]); task=json.load(sys.stdin); grouped={}; symbols=set()
for bar in task['bars']:
 end=datetime.fromisoformat(bar['time'].replace('Z','+00:00'))
 start=(end-timedelta(minutes=1)).astimezone(ZoneInfo('America/New_York'))
 assert start.second==0 and start.microsecond==0, 'Minute fixture requires minute-aligned timestamps'
 day=start.strftime('%Y%m%d'); millis=(start.hour*3600+start.minute*60)*1000
 for symbol,cents in bar['prices'].items():
  symbol=symbol.lower(); symbols.add(symbol)
  if cents is None: continue
  scaled=cents*100
  grouped.setdefault((symbol,day),[]).append(f'{millis},{scaled},{scaled},{scaled},{scaled},1000000')
for (symbol,day),rows in grouped.items():
 directory=root/'equity'/'usa'/'minute'/symbol; directory.mkdir(parents=True,exist_ok=True)
 with zipfile.ZipFile(directory/(day+'_trade.zip'),'w',compression=zipfile.ZIP_DEFLATED) as archive:
  member=zipfile.ZipInfo(day+'_'+symbol+'_minute_trade.csv',date_time=(2024,1,1,0,0,0)); member.compress_type=zipfile.ZIP_DEFLATED
  archive.writestr(member,'\\n'.join(rows)+'\\n')
for symbol in symbols:
 for folder,content in [('map_files',f'20000101,{symbol},usa\\n20501231,{symbol},usa\\n'),('factor_files','20000101,1,1,1\\n20501231,1,1,1\\n')]:
  path=root/'equity'/'usa'/folder/(symbol+'.csv'); path.parent.mkdir(parents=True,exist_ok=True); path.write_text(content)
`, dataDirectory], { input: JSON.stringify(input) })
}

async function fileHashes(directory, prefix = '') {
  const result = {}
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name, path = join(directory, entry.name)
    if (entry.isDirectory()) Object.assign(result, await fileHashes(path, relative + '/'))
    else if (entry.isFile()) result[relative] = hash(await readFile(path))
  }
  return result
}

export async function qualifyLean(evidenceDirectory) {
  const evidence = resolve(evidenceDirectory)
  await mkdir(evidence, { recursive: true })
  const inspected = await command('docker', ['image', 'inspect', QUALIFICATION_IMAGE])
  const image = JSON.parse(inspected.stdout)[0]
  await writeFile(join(evidence, 'image-inspect.json'), inspected.stdout)
  const metadata = join(evidence, 'metadata')
  await mkdir(metadata, { recursive: true })
  const extractName = `lean-benchmark-metadata-${process.pid}`
  await command('docker', ['create', '--name', extractName, '--network', 'none', QUALIFICATION_IMAGE])
  try {
    for (const folder of ['market-hours', 'symbol-properties']) await command('docker', ['cp', `${extractName}:/Lean/Data/${folder}`, metadata])
  } finally { await command('docker', ['rm', extractName], { acceptFailure: true }) }
  const report = { kind: 'lean-apparatus-qualification', countedStudy: false, atomsApproved: false, image: QUALIFICATION_IMAGE, imageId: image.Id, metadataHashes: await fileHashes(metadata), cases: [] }
  for (const fixture of qualificationFixtures()) {
    console.log(`Qualifying ${fixture.id} in the pinned LEAN engine`)
    const catalog = leanCatalog()
    if (fixture.reverseOrder) catalog.find(bundle => bundle.id === 'race').slotOrder = ['second', 'first']
    const compiled = await compilePrompt(catalog, fixture.root), expected = interpretLean(compiled.semantic, fixture.input)
    if (fixture.handTrace) assert.deepEqual(expected.trace, fixture.handTrace)
    if (fixture.bars) assert.deepEqual(expected.trace.map(fill => fill.bar), fixture.bars)
    if (fixture.quantities) assert.deepEqual(expected.trace.map(fill => fill.quantity), fixture.quantities)
    if (fixture.reasons) assert.deepEqual(expected.trace.map(fill => fill.reason), fixture.reasons)
    if (fixture.id === 'race-nested-owner') assert.ok(expected.trace.every(fill => fill.path.includes('/strategy/first/')))
    if (fixture.id === 'reverse-race-order') assert.ok(expected.trace.every(fill => fill.path.includes('/strategy/second/')))
    if (fixture.id === 'depth-seven') assert.ok(expected.trace.some(fill => fill.path.split('/').length >= 9))
    const python = await command('python3', [join(sourceRoot, 'lean-reference.py')], { input: canonical({ semantic: compiled.semantic, input: fixture.input }) })
    assert.deepEqual(JSON.parse(python.stdout), expected)
    const directory = join(evidence, fixture.id), algorithm = join(directory, 'algorithm'), data = join(directory, 'data'), results = join(directory, 'results')
    for (const path of [algorithm, data, results, join(data, 'market-hours'), join(data, 'symbol-properties')]) await mkdir(path, { recursive: true })
    await writeMinuteFixtures(data, fixture.input)
    const source = generateLeanProgram({ ...fixture, compiled })
    await writeFile(join(algorithm, 'main.py'), source)
    await copyFile(join(sourceRoot, 'lean-reference.py'), join(algorithm, 'lean_reference.py'))
    await copyFile(join(sourceRoot, 'execution_reference.py'), join(algorithm, 'execution_reference.py'))
    await writeFile(join(directory, 'task.json'), json({ ...fixture, compiled }))
    await writeFile(join(directory, 'expected.json'), json(expected))
    const configPath = join(directory, 'config.json')
    await writeFile(configPath, json(leanQualificationConfig(fixture.id)))
    const name = `lean-benchmark-${process.pid}-${fixture.id}`
    const args = ['run', '--rm', '--name', name, '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '512', '--memory', '2g', '--cpus', '2', '--read-only', '--tmpfs', '/tmp:rw,size=256m', '-e', 'PYTHONDONTWRITEBYTECODE=1', '-e', 'MPLCONFIGDIR=/tmp/matplotlib',
      '--mount', `type=bind,source=${algorithm},target=/Algorithm,readonly`, '--mount', `type=bind,source=${data},target=/Data,readonly`,
      '--mount', `type=bind,source=${join(metadata, 'market-hours')},target=/Data/market-hours,readonly`, '--mount', `type=bind,source=${join(metadata, 'symbol-properties')},target=/Data/symbol-properties,readonly`,
      '--mount', `type=bind,source=${results},target=/Results`, '--mount', `type=bind,source=${configPath},target=/Config/config.json,readonly`,
      QUALIFICATION_IMAGE, '--config', '/Config/config.json']
    let execution
    try { execution = await command('docker', args, { timeout: 120000, acceptFailure: true }) }
    finally { await command('docker', ['rm', '-f', name], { acceptFailure: true }) }
    await writeFile(join(directory, 'execution.json'), json(execution))
    await writeFile(join(directory, 'stdout.log'), execution.stdout)
    await writeFile(join(directory, 'stderr.log'), execution.stderr)
    assert.equal(execution.code, 0, `Engine failed for ${fixture.id}: ${execution.stderr}\n${execution.stdout}`)
    const traceLines = execution.stdout.split('\n').filter(line => line.includes('BENCHMARK_TRACE '))
    assert.ok(traceLines.length, `LEAN produced no complete trace for ${fixture.id}; inspect ${directory}`)
    const actual = JSON.parse(traceLines.at(-1).split('BENCHMARK_TRACE ')[1])
    assert.deepEqual(actual, expected.trace, `LEAN trace differs for ${fixture.id}`)
    const nativeResult = JSON.parse(await readFile(join(results, `${fixture.id}.json`), 'utf8'))
    const nativeEvents = JSON.parse(await readFile(join(results, `${fixture.id}-order-events.json`), 'utf8'))
    assert.equal(nativeResult.state.Status, 'Completed')
    assert.equal(nativeResult.state.RuntimeError, '')
    const nativeTrace = normalizeOrderEvents(nativeEvents, nativeResult.orders, { ...fixture, compiled })
    assert.deepEqual(nativeTrace, expected.trace, `Native engine artifacts differ for ${fixture.id}`)
    await writeFile(join(directory, 'actual-trace.json'), json(actual))
    await writeFile(join(directory, 'native-trace.json'), json(nativeTrace))
    report.cases.push({ id: fixture.id, status: 'passed', nativeArtifactsVerified: true, traceLength: actual.length, depth: compiled.depth, inputSha256: hash(canonical(fixture.input)), sourceSha256: hash(source), dataHashes: await fileHashes(data) })
    await writeFile(join(evidence, 'qualification.json'), json(report))
  }
  report.status = 'passed'
  report.sourceHashes = await fileHashes(sourceRoot)
  await writeFile(join(evidence, 'qualification.json'), json(report))
  console.log(json(report))
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Pass an evidence directory; this harness performs real local Docker backtests.')
  await qualifyLean(process.argv[2])
}
