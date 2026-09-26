import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// These exercise the real PowerShell boundary on Windows, with an owned Node
// child standing in only for the process/argv assertion. -ValidateOnly never
// loads UI Automation or sends native input; this is not provider or GUI proof.
const script = fileURLToPath(new URL('../lib/page2-native-picker.ps1', import.meta.url))
const windowsOnly = process.platform === 'win32' ? false : 'Requires native Windows PowerShell and process ownership APIs'

function fixture(t, { scoped = true } = {}) {
  const profile = realpathSync.native(os.homedir())
  const temp = realpathSync.native(os.tmpdir())
  assert.ok(temp.toLowerCase().startsWith(`${profile}${path.sep}`.toLowerCase()), 'Scratch temp must stay in the owning profile')
  const parent = mkdtempSync(path.join(temp, 'page2-picker-contract-'))
  const qaRoot = path.join(parent, 'qa root with spaces')
  const userData = path.join(qaRoot, 'user data')
  mkdirSync(userData, { recursive: true })
  const requestPath = path.join(qaRoot, 'request.json')
  const resultPath = path.join(qaRoot, 'result.json')
  const selectedPath = path.join(qaRoot, 'probe.txt')
  writeFileSync(selectedPath, 'owned picker fixture\n')
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', ...(scoped ? [`--user-data-dir=${userData}`] : [])], { windowsHide: true, stdio: 'ignore' })
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve))
      child.kill()
      await exited
    }
    rmSync(parent, { recursive: true, force: true })
  })
  const run = ({ request = { operation: 'select-path', selectedPath }, expectedProfile = profile, result = resultPath, pid = child.pid } = {}) => {
    writeFileSync(requestPath, JSON.stringify(request))
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const completed = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-QaRoot', qaRoot, '-ExpectedProfileRoot', expectedProfile, '-QaProcessId', String(pid), '-RequestPath', requestPath, '-ResultPath', result, '-ValidateOnly'],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 })
    assert.equal(completed.error, undefined, completed.error?.message)
    const lines = completed.stdout.trim().split(/\r?\n/)
    const value = JSON.parse(lines.at(-1))
    return { ...completed, value }
  }
  return { profile, parent, qaRoot, userData, requestPath, resultPath, selectedPath, child, run }
}

test('native picker accepts an owned PID with an explicit contained user-data path', { skip: windowsOnly }, t => {
  const f = fixture(t)
  const { status, value } = f.run()
  assert.equal(status, 0)
  assert.equal(value.code, 'QA_VALIDATED')
  assert.equal(value.nativeInputSent, false)
  assert.equal(value.pid, f.child.pid)
  assert.equal(value.userData, f.userData)
  assert.deepEqual(JSON.parse(readFileSync(f.resultPath, 'utf8')), value)
})

test('native picker refuses another profile before reading the request or writing a result', { skip: windowsOnly }, t => {
  const f = fixture(t)
  const { status, value } = f.run({ expectedProfile: path.join(path.dirname(f.profile), '__not_this_account__') })
  assert.equal(status, 1)
  assert.equal(value.code, 'QA_PROFILE_MISMATCH')
  assert.equal(value.nativeInputSent, false)
  assert.equal(existsSync(f.resultPath), false)
})

test('native picker refuses a PID without the owned user-data command-line argument', { skip: windowsOnly }, t => {
  const f = fixture(t, { scoped: false })
  const { status, value } = f.run()
  assert.equal(status, 1)
  assert.equal(value.code, 'QA_PROCESS_SCOPE_MISMATCH')
  assert.equal(value.nativeInputSent, false)
})

test('native picker refuses an ended PID', { skip: windowsOnly }, t => {
  const f = fixture(t)
  const { status, value } = f.run({ pid: 2147483647 })
  assert.equal(status, 1)
  assert.equal(value.code, 'QA_PROCESS_NOT_FOUND')
})

test('native picker rejects sibling-prefix paths before testing their existence', { skip: windowsOnly }, t => {
  const f = fixture(t)
  const { status, value } = f.run({ request: { operation: 'select-path', selectedPath: `${f.qaRoot}-sibling\\missing.txt` } })
  assert.equal(status, 1)
  assert.equal(value.code, 'QA_PATH_OUTSIDE_ROOT')
  assert.equal(value.nativeInputSent, false)
})

test('native picker refuses an out-of-scope result path without writing it', { skip: windowsOnly }, t => {
  const f = fixture(t)
  const outsideResult = path.join(f.parent, 'not-the-qa-result.json')
  const { status, value } = f.run({ result: outsideResult })
  assert.equal(status, 1)
  assert.equal(value.code, 'QA_PATH_OUTSIDE_ROOT')
  assert.equal(existsSync(outsideResult), false)
})

test('native picker refuses junctions even when their target is also owned', { skip: windowsOnly }, t => {
  const f = fixture(t)
  const target = path.join(f.qaRoot, 'ordinary')
  const junction = path.join(f.qaRoot, 'linked')
  mkdirSync(target)
  symlinkSync(target, junction, 'junction')
  const { status, value } = f.run({ request: { operation: 'select-path', selectedPath: junction } })
  assert.equal(status, 1)
  assert.equal(value.code, 'QA_PATH_LINK')
})

test('native picker refuses hard-linked files', { skip: windowsOnly }, t => {
  const f = fixture(t)
  const linked = path.join(f.qaRoot, 'linked.txt')
  linkSync(f.selectedPath, linked)
  const { status, value } = f.run({ request: { operation: 'select-path', selectedPath: linked } })
  assert.equal(status, 1)
  assert.equal(value.code, 'QA_PATH_LINK')
})

test('native picker accepts cancel and inspection as validation-only operations', { skip: windowsOnly }, t => {
  const f = fixture(t)
  for (const operation of ['cancel', 'inspect', 'dismiss-update', 'close-app']) {
    const { status, value } = f.run({ request: { operation } })
    assert.equal(status, 0)
    assert.equal(value.nativeInputSent, false)
  }
})

test('native picker refuses unsupported operations', { skip: windowsOnly }, t => {
  const f = fixture(t)
  const { status, value } = f.run({ request: { operation: 'kill-process-tree' } })
  assert.equal(status, 1)
  assert.equal(value.code, 'QA_OPERATION_UNKNOWN')
})
