// An operating-system failure is not evidence that a registry PATH is absent.
// These tests drive the ambient Windows/cache branch by temporarily replacing
// the asynchronous Node primitives at its boundary. They count reg.exe calls:
// an EMFILE must be retried forever rather than latched, while successful text
// must retain the one-read-per-key cache that this module exists to provide.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import childProcess from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const searchPath = require('../../shell/machine-search-path.cjs')

function registryText(value) {
  return `    Path    REG_EXPAND_SZ    ${value}\r\n`
}

async function withWindowsRegistry(readRegistry, run, execFile = null) {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  const originalSync = childProcess.execFileSync
  const originalAsync = childProcess.execFile
  const originalStat = fs.statSync
  const originalAsyncStat = fs.promises.stat
  searchPath.invalidateMachineSearchPath()
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  childProcess.execFileSync = () => { throw new Error('Synchronous registry I/O is forbidden') }
  childProcess.execFile = (file, args, options, callback) => {
    if (args[0] === 'query') {
      queueMicrotask(() => {
        try { callback(null, readRegistry(file, args, options)) }
        catch (error) { callback(error, '') }
      })
      return { unref() {} }
    }
    if (execFile) return execFile(file, args, options, callback)
    callback(Object.assign(new Error('npm absent'), { code: 'ENOENT' }), '')
    return { unref() {} }
  }
  fs.statSync = () => { throw new Error('Synchronous program search is forbidden') }
  fs.promises.stat = async () => ({ isFile: () => true })
  try {
    await run()
  } finally {
    childProcess.execFileSync = originalSync
    childProcess.execFile = originalAsync
    fs.statSync = originalStat
    fs.promises.stat = originalAsyncStat
    Object.defineProperty(process, 'platform', platform)
    searchPath.invalidateMachineSearchPath()
  }
}

test('EMFILE is could-not-tell and is never cached or latched', async () => {
  let reads = 0
  await withWindowsRegistry(() => {
    reads += 1
    throw Object.assign(new Error('busy'), { code: 'EMFILE' })
  }, async () => {
    const first = searchPath.machineSearchPath()
    await searchPath.warmMachineSearchPath()
    const second = searchPath.machineSearchPath()
    await searchPath.warmMachineSearchPath()
    const third = searchPath.machineSearchPath()
    await searchPath.warmMachineSearchPath()
    assert.equal(first.complete, false)
    assert.equal(second.complete, false)
    assert.equal(third.complete, false)
    assert.equal(reads, 6, 'each later attempt must retry both answers that the machine could not provide')
  })
})

test('successful registry answers retain the one-read-per-key cache', async () => {
  let reads = 0
  await withWindowsRegistry((_file, args) => {
    reads += 1
    return registryText(args[1].startsWith('HKLM') ? 'C:\\Machine' : 'C:\\User')
  }, async () => {
    const first = searchPath.machineSearchPath()
    await searchPath.warmMachineSearchPath()
    const second = searchPath.machineSearchPath()
    const third = searchPath.machineSearchPath()
    assert.equal(first.complete, false, 'the asynchronous package-manager layer has not settled yet')
    assert.notEqual(second, first, 'completed registry data must replace the provisional snapshot')
    assert.equal(third, second)
    await searchPath.warmMachineSearchPath()
    assert.equal(reads, 2, 'a healthy registry must still be read exactly once per key')
  })
})

test('a timed-out package-manager question is not settled or latched', async () => {
  let registryReads = 0
  let packageReads = 0
  await withWindowsRegistry((_file, args) => {
    registryReads += 1
    if (String(args[0]).toLowerCase() === 'query') {
      return registryText(args[1].startsWith('HKLM') ? 'C:\\Machine' : 'C:\\User')
    }
    return { isFile: () => true }
  }, async () => {
    const first = searchPath.machineSearchPath()
    await searchPath.warmMachineSearchPath()
    const second = searchPath.machineSearchPath()
    await searchPath.warmMachineSearchPath()
    assert.equal(first.complete, false)
    assert.equal(second.complete, false)
    assert.equal(packageReads, 2, 'a timeout must permit a later package-manager attempt')
    assert.equal(registryReads, 2, 'retrying npm must not repay the registry-read cost')
  }, (_file, _args, _options, callback) => {
    packageReads += 1
    callback(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), '')
    return { unref() {} }
  })
})
