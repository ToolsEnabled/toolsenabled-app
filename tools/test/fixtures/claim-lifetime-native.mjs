/* Explicit native fixture: disposable children and files only. No account,
   vault, relay or owner state. The production proxy and containment run as-is.
   node this-file --out <new absolute directory> [--engine <Windows payload>]
   Optional --runtime <Electron executable> --owner-module <packaged module>.
   These options let the identical fixture exercise an actual packaged proxy. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const args = process.argv.slice(2)
const argument = name => { const at = args.indexOf(name); return at < 0 ? '' : args[at + 1] }
const mode = argument('--mode')
const output = argument('--out')
const payload = argument('--engine') || (process.platform === 'linux' ? output : '')
const runtime = argument('--runtime') || process.execPath
const appRoot = path.resolve(import.meta.dirname, '../../..')
const moduleFile = argument('--owner-module') || path.join(appRoot, 'shell', 'claim-lifetime-process.cjs')
const lifetime = require(moduleFile)
const receipts = require(path.join(path.dirname(moduleFile), 'claim-lifetime-receipts.cjs'))
const relay = require(path.join(path.dirname(moduleFile), 'relay-supervisor.cjs'))
const self = fileURLToPath(import.meta.url)
assert(path.isAbsolute(output || '') && path.isAbsolute(payload || '') && path.isAbsolute(runtime),
  'explicit absolute fixture roots and runtime required')

function writeSynced(file, value) {
  const fd = fs.openSync(file, 'wx', 0o600)
  try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  if (process.platform === 'linux') {
    const directory = fs.openSync(path.dirname(file), 'r')
    try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
  }
}

if (mode === 'verify') {
  const expected = JSON.parse(fs.readFileSync(path.join(output, 'expected-owner.json'), 'utf8'))
  const verified = receipts.reconcileOwnership(output, expected)
  assert.equal(verified.quiescent, true)
  process.stdout.write(JSON.stringify(verified) + '\n')
} else if (mode === 'gui') {
  const stage = argument('--stage')
  const environment = relay.relayChildEnvironment(process.env, { stateRoot: output })
  const owned = lifetime.spawnClaimLifetime({ spawn, command: runtime,
    args: [path.join(output, 'target.cjs')], payloadRoot: payload, stateRoot: output, environment,
    onOwnershipStart(descriptor) {
      writeSynced(path.join(output, 'expected-owner.json'), descriptor)
      process.send({ stage: 'PERSISTED' })
      return stage === 'before-start' ? new Promise(() => {}) : true
    },
  })
  let stdout = ''
  owned.child.stdout.on('data', data => {
    stdout += String(data)
    assert(stdout.length < 4096)
    if (stdout.includes('TREE_READY')) process.send({ stage: 'TREE_READY' })
  })
  owned.child.stderr.on('data', () => {})
  const result = await owned.completion
  process.send({ stage: 'COMPLETE', result }, () => process.disconnect())
} else {
  assert.equal(fs.existsSync(output), false, 'fixture output must be a fresh directory')
  fs.mkdirSync(output, { recursive: true, mode: 0o700 })
  const records = []
  const report = { startedAt: new Date().toISOString(), platform: process.platform, node: process.version,
    runtime, scope: 'actual disposable GUI loss and owned CLI tree reconciliation; no account or credential mutation',
    source: Object.fromEntries(['claim-lifetime-process.cjs', 'claim-lifetime-owner.cjs',
      'claim-lifetime-receipts.cjs', 'owned-claim-process.cjs', 'owned-claim-process-linux.py'].map(name =>
      [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(path.dirname(moduleFile), name))).digest('hex')])),
    records, ok: false }
  const common = ['--engine', payload, '--runtime', runtime, '--owner-module', moduleFile]
  const environment = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

  async function run(stage) {
    const directory = path.join(output, stage)
    fs.mkdirSync(directory, { mode: 0o700 })
    const grandchild = `const fs=require('node:fs');process.stdout.write('GRANDCHILD_READY\\n');
      setTimeout(()=>fs.writeFileSync(process.argv[1],'must not happen'),3000);setInterval(()=>{},1000);`
    const target = stage === 'normal' ? "process.stdout.write('NORMAL_COMPLETE\\n')" :
      `const fs=require('node:fs');const path=require('node:path');const {spawn}=require('node:child_process');
      fs.writeFileSync(path.join(__dirname,'target-started.txt'),'started');
      const descendant=spawn(process.execPath,['-e',${JSON.stringify(grandchild)},path.join(__dirname,'late-mutation.txt')],
        {detached:true,windowsHide:true,stdio:['ignore','pipe','ignore']});
      descendant.stdout.once('data',()=>process.stdout.write('TREE_READY\\n'));setInterval(()=>{},1000);`
    fs.writeFileSync(path.join(directory, 'target.cjs'), target)
    const gui = spawn(runtime, [self, '--mode', 'gui', '--stage', stage, '--out', directory, ...common],
      { env: environment, cwd: directory, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    let stderr = ''
    let targetReady = false
    let killed = false
    let guiResult = null
    let failure = null
    gui.stdout.on('data', () => {})
    gui.stderr.on('data', data => { stderr += String(data); if (stderr.length > 4096) stderr = stderr.slice(-4096) })
    gui.on('message', message => {
      if (message.stage === 'COMPLETE') guiResult = message.result
      const ready = stage === 'before-start' ? 'PERSISTED' : 'TREE_READY'
      if (stage !== 'normal' && message.stage === ready && !killed) {
        targetReady = true
        killed = gui.kill('SIGKILL') === true
      }
    })
    gui.on('error', error => { failure = error.message })
    const close = new Promise(resolve => gui.once('close', (code, signal) => resolve({ code, signal })))
    let timer
    const cap = new Promise((_, reject) => { timer = setTimeout(() => {
      gui.kill('SIGKILL'); reject(Error('Disposable GUI exceeded fixture deadline'))
    }, 30_000) })
    let closed
    try { closed = await Promise.race([close, cap]) } finally { clearTimeout(timer) }
    assert.equal(failure, null)
    const expected = JSON.parse(fs.readFileSync(path.join(directory, 'expected-owner.json'), 'utf8'))
    let verified
    const deadline = Date.now() + 25_000
    do {
      verified = receipts.reconcileOwnership(directory, expected)
      if (verified.quiescent) break
      await delay(50)
    } while (Date.now() < deadline)
    const record = { stage, killed, targetReady, guiClosed: closed, guiResult, verified, stderr }
    records.push(record)
    assert.equal(verified.quiescent, true, stage + ' must produce a genuine signed terminal receipt')
    if (stage === 'normal') {
      assert.equal(guiResult?.quiescent, true)
      assert.equal(verified.receipt.exitedNormally, true)
      assert.equal(verified.receipt.exitCode, 0)
    } else {
      assert.equal(killed, true)
      assert.equal(targetReady, true)
      assert.equal(verified.receipt.exitedNormally, false)
      assert.equal(verified.receipt.started, stage === 'after-start')
    }
    if (stage === 'before-start') assert.equal(fs.existsSync(path.join(directory, 'target-started.txt')), false)
    assert.equal(fs.existsSync(path.join(directory, 'late-mutation.txt')), false)
    const fresh = spawnSync(runtime, [self, '--mode', 'verify', '--out', directory, ...common],
      { env: environment, cwd: directory, windowsHide: true, encoding: 'utf8', timeout: 15_000 })
    assert.equal(fresh.status, 0, fresh.stderr)
    assert.deepEqual(JSON.parse(fresh.stdout), verified)
    record.freshProcessVerified = true
  }
  try {
    for (const stage of ['normal', 'before-start', 'after-start']) await run(stage)
    report.ok = true
  } catch (error) {
    report.error = { name: error.name, message: error.message }
    process.exitCode = 1
  } finally {
    report.finishedAt = new Date().toISOString()
    fs.writeFileSync(path.join(output, 'native-report.json'), JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify(report))
  }
}
