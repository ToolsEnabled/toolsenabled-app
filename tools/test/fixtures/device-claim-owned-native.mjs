/* Explicit native ownership fixture, never a real account/vault mutation.
   Usage: node this-file --out <owned-absolute-directory> --engine <payload>
   Linux does not need --engine. The production owner/helper runs unchanged. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import ownedModule from '../../../shell/owned-claim-process.cjs'
import relayModule from '../../../shell/relay-supervisor.cjs'

const args = process.argv.slice(2)
const argument = name => { const at = args.indexOf(name); return at < 0 ? '' : args[at + 1] }
const output = argument('--out')
const payload = argument('--engine') || (process.platform === 'linux' ? output : '')
assert(path.isAbsolute(output || '') && path.isAbsolute(payload || ''), 'explicit absolute fixture roots required')
fs.mkdirSync(output, { recursive: true })
const records = []
const startedAt = new Date().toISOString()
const digest = value => crypto.createHash('sha256').update(value).digest('hex')
const root = path.resolve(import.meta.dirname, '../../..')
const source = Object.fromEntries(['shell/owned-claim-process.cjs', 'shell/owned-claim-process-linux.py'].map(file =>
  [file, digest(fs.readFileSync(path.join(root, file)))]))
const report = { startedAt, platform: process.platform, node: process.version, source,
  scope: 'native owned CLI/descendant cleanup only; no account, credential or owner state', records, ok: false }

async function run(name, code, cancelWhenReady = false) {
  const stateRoot = path.join(output, name)
  fs.mkdirSync(stateRoot)
  const file = path.join(stateRoot, 'fixture.cjs')
  fs.writeFileSync(file, code)
  const environment = relayModule.relayChildEnvironment(process.env, { stateRoot })
  const owned = ownedModule.spawnOwnedClaim({ spawn, command: process.execPath, args: [file],
    payloadRoot: payload, stateRoot, environment })
  let stdout = ''
  let stderr = ''
  owned.child.stdout.on('data', chunk => {
    stdout += String(chunk)
    assert(stdout.length < 4096, 'fixture output bounded')
    if (cancelWhenReady && stdout.includes('FIXTURE_READY')) owned.cancel().catch(() => {})
  })
  owned.child.stderr.on('data', chunk => { stderr += String(chunk); assert(stderr.length < 4096) })
  let timer
  const cap = new Promise((_, reject) => {
    timer = setTimeout(() => { owned.cancel().catch(() => {}); reject(Error('Native owner fixture exceeded its cap')) }, 25_000)
  })
  let result
  try { result = await Promise.race([owned.completion, cap]) } finally { clearTimeout(timer) }
  let nativeReceipt = null
  if (owned.child.jobOutcome) {
    const outcome = await owned.child.jobOutcome
    const closed = await owned.child.jobClosed
    nativeReceipt = { outcome, wrapperClosed: true, wrapperExitCode: closed.code,
      wrapperSignal: closed.signal, wrapperFailure: closed.failure?.code || null }
  }
  records.push({ name, result, nativeReceipt, stdout, stderr })
  assert.equal(result.quiescent, true, name + ' must have a real empty-owner receipt')
  return { result, stateRoot }
}

function descendantCode(parentExits) {
  const grandchild = `const fs=require('node:fs');const path=require('node:path');
    process.stdout.write('GRANDCHILD_READY\\n');
    setTimeout(()=>fs.writeFileSync(path.join(process.argv[1],'late-mutation.txt'),'must not happen'),3000);
    setInterval(()=>{},1000);`
  return `const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e',${JSON.stringify(grandchild)},__dirname],
      {detached:true,windowsHide:true,stdio:['ignore','pipe','ignore']});
    child.stdout.once('data',()=>{process.stdout.write('FIXTURE_READY\\n');
      ${parentExits ? 'process.exit(0)' : 'setInterval(()=>{},1000)'}});`
}

try {
  const normal = await run('normal', "process.stdout.write('{\"connected\":false}\\n')")
  assert.equal(normal.result.exitedNormally, true)
  assert.equal(normal.result.exitCode, 0)
  const detached = await run('root-exits-before-detached-descendant', descendantCode(true))
  assert.equal(detached.result.exitCode, 0)
  assert.equal(fs.existsSync(path.join(detached.stateRoot, 'late-mutation.txt')), false)
  const cancelled = await run('cancel-mutating-descendant-tree', descendantCode(false), true)
  assert.equal(cancelled.result.exitedNormally, false)
  assert.equal(fs.existsSync(path.join(cancelled.stateRoot, 'late-mutation.txt')), false)
  report.ok = true
} catch (error) {
  report.error = { name: error.name, message: error.message }
  process.exitCode = 1
} finally {
  report.finishedAt = new Date().toISOString()
  fs.writeFileSync(path.join(output, 'native-report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
}
