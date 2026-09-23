import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../../shell/machine-search-path.cjs', import.meta.url), 'utf8')
const registryText = value => `    Path    REG_EXPAND_SZ    ${value}\r\n`
const flush = () => new Promise(resolve => setImmediate(resolve))
const missing = () => Object.assign(new Error('fixture entry absent'), { code: 'ENOENT' })

// Execute the real module with inert OS boundaries. No process, provider home,
// registry key or executable on the test machine is consulted. Held callbacks
// prove ordering independently of machine load or a timing threshold.
function fixture({ npmDirectory = 'Q:\\RegistryNpm', statError = null } = {}) {
  const calls = [], syncCalls = [], statCalls = []
  const fakeProcess = { platform: 'win32', env: { SystemRoot: 'Q:\\Windows', PATH: 'Q:\\Inherited' } }
  const childProcess = {
    execFileSync(file, args, options) {
      syncCalls.push({ file, args, options })
      return registryText('Q:\\SynchronousOnly')
    },
    execFile(file, args, options, callback) {
      const call = { file, args, options, callback, settled: false, kind: args[0] === 'query' ? 'registry' : 'package' }
      calls.push(call)
      return { unref() {} }
    },
  }
  const fakeFs = {
    statSync(file) { syncCalls.push({ stat: file }); throw missing() },
    promises: { async stat(file) {
      statCalls.push(file)
      if (statError) throw Object.assign(new Error('fixture directory unreadable'), { code: statError })
      if (npmDirectory && file === path.win32.join(npmDirectory, 'npm.CMD')) return { isFile: () => true }
      throw missing()
    } },
  }
  const module = { exports: {} }
  const require = name => ({ 'node:child_process': childProcess, 'node:fs': fakeFs,
    'node:path': path.win32, 'node:os': { userInfo: () => ({ homedir: '/fixture/login' }) } })[name]
  vm.runInNewContext('(function(require,module,exports,process){\n' + source + '\n})', {}, { filename: 'machine-search-path.cjs' })(require, module, module.exports, fakeProcess)
  const pending = kind => calls.filter(call => call.kind === kind && !call.settled)
  const answer = (call, error, stdout = '') => {
    assert.ok(call && !call.settled, 'each held callback settles once')
    call.settled = true
    call.callback(error, stdout)
  }
  const answerRegistry = (machine = 'Q:\\RegistryNpm', user = 'Q:\\User') => {
    const held = pending('registry')
    assert.equal(held.length, 2)
    for (const call of held) answer(call, null, registryText(call.args[1].startsWith('HKLM') ? machine : user))
  }
  return { api: module.exports, fakeProcess, calls, syncCalls, statCalls, pending, answer, answerRegistry }
}

test('startup warm-up starts bounded asynchronous registry reads and returns before they settle', async () => {
  const f = fixture()
  const warming = f.api.warmMachineSearchPath()
  assert.equal(f.syncCalls.length, 0, 'startup entered synchronous subprocess or program-search I/O')
  assert.equal(f.pending('registry').length, 2)
  assert.equal(typeof warming.then, 'function')
  for (const call of f.pending('registry')) {
    assert.equal(call.file, 'Q:\\Windows\\System32\\reg.exe')
    assert.equal(call.options.timeout, 2500)
    assert.equal(call.options.maxBuffer, 512 * 1024)
    assert.equal(call.options.windowsHide, true)
  }
  let settled = false
  warming.then(() => { settled = true })
  await flush()
  assert.equal(settled, false)
  assert.equal(f.statCalls.length, 0, 'npm discovery ran before registry directories arrived')
  const provisional = f.api.machineSearchPath()
  assert.deepEqual([...provisional.directories], ['Q:\\Inherited'])
  assert.equal(provisional.complete, false)
  assert.equal(f.pending('registry').length, 2, 'snapshot lookup duplicated pending discovery')
  f.answerRegistry()
  await flush()
  assert.equal(f.pending('package').length, 1, 'registry-only npm directory was not searched')
  const command = f.pending('package')[0]
  assert.equal(command.file, 'Q:\\Windows\\System32\\cmd.exe')
  assert.equal(command.options.timeout, 10000)
  assert.equal(command.options.maxBuffer, 64 * 1024)
  assert.equal(command.options.windowsHide, true)
  f.answer(command, null, 'Q:\\CustomPrefix\r\n')
  await warming
  const complete = f.api.machineSearchPath()
  assert.equal(complete.complete, true)
  assert.ok(complete.directories.includes('Q:\\CustomPrefix'))
  assert.notEqual(complete, provisional)
  assert.equal(f.api.machineSearchPath(), complete, 'settled cache identity changed without new data')
  assert.equal(f.calls.length, 3)
})

test('missing npm is complete only after asynchronous directory discovery finishes', async () => {
  const f = fixture({ npmDirectory: null })
  const warming = f.api.warmMachineSearchPath()
  assert.equal(f.syncCalls.length, 0)
  f.answerRegistry('Q:\\Machine', 'Q:\\User')
  await warming
  assert.ok(f.statCalls.length > 0)
  assert.equal(f.pending('package').length, 0)
  assert.equal(f.api.machineSearchPath().complete, true)
})

test('unreadable npm search remains unknown rather than a proven absence', async () => {
  const f = fixture({ statError: 'EACCES' })
  const warming = f.api.warmMachineSearchPath()
  assert.equal(f.syncCalls.length, 0)
  f.answerRegistry()
  await warming
  assert.equal(f.api.machineSearchPath().complete, false)
  assert.equal(f.pending('package').length, 0)
})

test('a failed registry key is retried later while the successful key stays cached', async () => {
  const f = fixture({ npmDirectory: null })
  const first = f.api.warmMachineSearchPath()
  assert.equal(f.syncCalls.length, 0)
  const initial = f.pending('registry')
  f.answer(initial.find(call => call.args[1].startsWith('HKLM')), null, registryText('Q:\\Machine'))
  f.answer(initial.find(call => call.args[1].startsWith('HKCU')), Object.assign(new Error('busy'), { code: 'EMFILE' }))
  await first
  const provisional = f.api.machineSearchPath()
  assert.equal(provisional.complete, false)
  assert.ok(provisional.directories.includes('Q:\\Machine'))
  const retry = f.api.warmMachineSearchPath()
  assert.equal(f.pending('registry').length, 1)
  assert.ok(f.pending('registry')[0].args[1].startsWith('HKCU'))
  f.answer(f.pending('registry')[0], null, registryText('Q:\\Recovered'))
  await retry
  assert.equal(f.api.machineSearchPath().complete, true)
  assert.ok(f.api.machineSearchPath().directories.includes('Q:\\Recovered'))
  assert.equal(f.calls.filter(call => call.kind === 'registry').length, 3)
})

test('failed package discovery permits one later attempt without repeating successful registry reads', async () => {
  const f = fixture()
  const first = f.api.warmMachineSearchPath()
  assert.equal(f.syncCalls.length, 0)
  f.answerRegistry()
  await flush()
  f.answer(f.pending('package')[0], Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }))
  await first
  assert.equal(f.api.machineSearchPath().complete, false)
  const retry = f.api.warmMachineSearchPath()
  await flush()
  assert.equal(f.pending('package').length, 1)
  assert.equal(f.calls.filter(call => call.kind === 'registry').length, 2)
  f.answer(f.pending('package')[0], null, 'Q:\\RecoveredPrefix\r\n')
  await retry
  assert.equal(f.api.machineSearchPath().complete, true)
  assert.ok(f.api.machineSearchPath().directories.includes('Q:\\RecoveredPrefix'))
})

test('invalidation during a registry read cannot publish old paths or multiply pending reads', async () => {
  const f = fixture({ npmDirectory: null })
  const old = f.api.warmMachineSearchPath()
  assert.equal(f.syncCalls.length, 0)
  f.api.invalidateMachineSearchPath()
  const fresh = f.api.warmMachineSearchPath()
  assert.equal(f.pending('registry').length, 2, 'obsolete bounded reads must settle before another batch')
  f.answerRegistry('Q:\\Obsolete', 'Q:\\OldUser')
  await old
  await flush()
  assert.equal(f.api.machineSearchPath().complete, false)
  assert.ok(!f.api.machineSearchPath().directories.includes('Q:\\Obsolete'))
  f.answerRegistry('Q:\\Current', 'Q:\\CurrentUser')
  await fresh
  const answer = f.api.machineSearchPath()
  assert.equal(answer.complete, true)
  assert.ok(answer.directories.includes('Q:\\Current'))
  assert.ok(!answer.directories.includes('Q:\\Obsolete'))
})

test('late package-manager completion after invalidation cannot install an old prefix', async () => {
  const f = fixture()
  const old = f.api.warmMachineSearchPath()
  assert.equal(f.syncCalls.length, 0)
  f.answerRegistry()
  await flush()
  const obsolete = f.pending('package')[0]
  f.api.invalidateMachineSearchPath()
  const fresh = f.api.warmMachineSearchPath()
  f.answer(obsolete, null, 'Q:\\ObsoletePrefix\r\n')
  await old
  await flush()
  assert.equal(f.api.machineSearchPath().complete, false)
  assert.ok(!f.api.machineSearchPath().directories.includes('Q:\\ObsoletePrefix'))
  f.answerRegistry()
  await flush()
  f.answer(f.pending('package')[0], null, 'Q:\\CurrentPrefix\r\n')
  await fresh
  assert.equal(f.api.machineSearchPath().complete, true)
  assert.ok(f.api.machineSearchPath().directories.includes('Q:\\CurrentPrefix'))
  assert.ok(!f.api.machineSearchPath().directories.includes('Q:\\ObsoletePrefix'))
})

test('fabricated and Linux snapshots remain independent of Windows discovery', () => {
  const f = fixture()
  const windows = f.api.machineSearchPath({ platform: 'win32', env: { PATH: 'Q:\\Fictional' } })
  assert.deepEqual([...windows.directories], ['Q:\\Fictional'])
  assert.equal(windows.complete, false)
  const linux = f.api.machineSearchPath({ platform: 'linux', env: { PATH: '/usr/bin:/bin' }, loginHome: '/fixture/login' })
  assert.deepEqual([...linux.directories], ['/usr/bin', '/bin', '/fixture/login/.local/bin', '/fixture/login/bin'])
  assert.equal(linux.complete, true)
  assert.equal(f.calls.length, 0)
  assert.equal(f.syncCalls.length, 0)
})
