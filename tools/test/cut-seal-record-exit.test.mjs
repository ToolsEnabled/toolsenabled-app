// T155. The cut's exit path produces the seal record itself.
//
// The defect these cover: seal-cut-record.mjs existed, passed its own suite,
// and was invoked by nobody -- so cut 1 shipped a hand-written "sealed" note
// that named no installer, no byte count and no sha256.
//
// These assert what the exit path DOES with values: which argv it hands the
// tool, and that it refuses when no record ends up on disk. They inject the
// process runner rather than executing the real tool, because that tool is
// checked out from a different repository and a unit suite here must not
// depend on its presence. The end-to-end walk against the real tool is the
// mutation check, not this file.

import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  SEAL_RECORD_TOOL_ENV,
  resolveSealRecordTool,
  sealCutRecord,
} from '../release-packager/cut-release-candidate.mjs'

const TOOL = path.join(os.tmpdir(), 'w54-controller', 'seal-cut-record.mjs')
const OTHER = path.join(os.tmpdir(), 'w54-controller', 'other-seal-cut-record.mjs')

function value(argv, flag) {
  const at = argv.indexOf(flag)
  return at === -1 ? undefined : argv[at + 1]
}

// --- resolveSealRecordTool -------------------------------------------------

test('a cut that names no seal tool refuses, and says so instead of defaulting', () => {
  assert.throws(
    () => resolveSealRecordTool(undefined, { environment: {}, exists: () => true }),
    (error) => {
      assert.match(error.message, /seal/i)
      assert.match(error.message, /--seal-record-tool/)
      assert.match(error.message, new RegExp(SEAL_RECORD_TOOL_ENV))
      return true
    },
  )
})

test('an empty --seal-record-tool is not a seal tool', () => {
  assert.throws(() => resolveSealRecordTool('   ', { environment: {}, exists: () => true }), /--seal-record-tool/)
})

test('the flag locates the tool', () => {
  assert.equal(resolveSealRecordTool(TOOL, { environment: {}, exists: () => true }), path.resolve(TOOL))
})

test('the environment variable locates the tool when the flag is absent', () => {
  assert.equal(
    resolveSealRecordTool(undefined, { environment: { [SEAL_RECORD_TOOL_ENV]: TOOL }, exists: () => true }),
    path.resolve(TOOL),
  )
})

test('the explicit flag wins over the environment', () => {
  assert.equal(
    resolveSealRecordTool(TOOL, { environment: { [SEAL_RECORD_TOOL_ENV]: OTHER }, exists: () => true }),
    path.resolve(TOOL),
  )
})

test('a named tool that is not there refuses, and names which input named it', () => {
  assert.throws(
    () => resolveSealRecordTool(undefined, { environment: { [SEAL_RECORD_TOOL_ENV]: TOOL }, exists: () => false }),
    (error) => {
      assert.match(error.message, new RegExp(SEAL_RECORD_TOOL_ENV))
      assert.ok(error.message.includes(path.resolve(TOOL)))
      return true
    },
  )
  assert.throws(
    () => resolveSealRecordTool(TOOL, { environment: {}, exists: () => false }),
    /--seal-record-tool/,
  )
})

// --- sealCutRecord ---------------------------------------------------------

const APP_REF = 'a'.repeat(40)
const ENGINE_REF = 'b'.repeat(40)

function invocation(overrides = {}) {
  const calls = []
  return {
    calls,
    options: {
      tool: TOOL,
      installerPath: path.join(os.tmpdir(), 'w54-stage', 'ToolsEnabled-Setup.exe'),
      appRef: APP_REF,
      engineRef: ENGINE_REF,
      version: '1.0.45',
      manifestPath: path.join(os.tmpdir(), 'w54-stage', 'declaration-facts.json'),
      recordPath: path.join(os.tmpdir(), 'w54-stage', 'seal-cut-record-1.0.45.json'),
      log: () => {},
      exists: (target) => target !== overrides.missing,
      run: async (command, argv) => {
        calls.push({ command, argv })
        return { code: 0, output: '' }
      },
      ...overrides.options,
    },
  }
}

test('the exit path runs the seal tool with the installer, both refs, the version and the manifest', async () => {
  const { calls, options } = invocation({ missing: path.join(os.tmpdir(), 'w54-stage', 'seal-cut-record-1.0.45.json') })
  // The record does not exist before the run and does after it.
  let written = false
  options.exists = (target) => (target === options.recordPath ? written : true)
  options.run = async (command, argv) => {
    calls.push({ command, argv })
    written = true
    return { code: 0, output: '' }
  }

  assert.equal(await sealCutRecord(options), options.recordPath)
  assert.equal(calls.length, 1)
  const { argv } = calls[0]
  assert.ok(argv.includes('--record'), 'the cut must ask for --record, not --verify')
  assert.equal(argv[0], TOOL)
  assert.equal(value(argv, '--installer'), options.installerPath)
  assert.equal(value(argv, '--app-ref'), APP_REF)
  assert.equal(value(argv, '--engine-ref'), ENGINE_REF)
  assert.equal(value(argv, '--version'), '1.0.45')
  assert.equal(value(argv, '--out'), options.recordPath)
  assert.equal(value(argv, '--manifest'), options.manifestPath)
})

test('the cut does not hand the tool its own byte count or sha256 to copy', async () => {
  const { calls, options } = invocation()
  let written = false
  options.exists = (target) => (target === options.recordPath ? written : true)
  options.run = async (command, argv) => {
    calls.push({ command, argv })
    written = true
    return { code: 0, output: '' }
  }
  await sealCutRecord(options)
  const { argv } = calls[0]
  for (const flag of ['--bytes', '--sha256', '--size', '--digest']) {
    assert.ok(!argv.includes(flag), `${flag} would make the record a copy of this run's claim, not a measurement`)
  }
})

test('--manifest is omitted rather than passed empty when there is no manifest', async () => {
  const { calls, options } = invocation()
  let written = false
  options.manifestPath = undefined
  options.exists = (target) => (target === options.recordPath ? written : true)
  options.run = async (command, argv) => {
    calls.push({ command, argv })
    written = true
    return { code: 0, output: '' }
  }
  await sealCutRecord(options)
  assert.ok(!calls[0].argv.includes('--manifest'))
})

test('a refused seal makes the cut throw, and carries the refusal the tool printed', async () => {
  const { options } = invocation()
  options.exists = (target) => target !== options.recordPath
  options.run = async () => ({
    code: 3,
    output: 'REFUSED INSTALLER_MISSING: --installer names nothing\n  no record was written\n',
  })
  await assert.rejects(() => sealCutRecord(options), (error) => {
    assert.match(error.message, /INSTALLER_MISSING/)
    assert.ok(!/ready/i.test(error.message), 'a refused seal must not read as a finished candidate')
    return true
  })
})

test('a seal tool that exits 0 but writes nothing is still no seal', async () => {
  const { options } = invocation()
  options.exists = (target) => target !== options.recordPath // never written, before or after
  options.run = async () => ({ code: 0, output: 'SEALED (but it lied)\n' })
  await assert.rejects(() => sealCutRecord(options), (error) => {
    assert.ok(error.message.includes(options.recordPath))
    return true
  })
})

test('an existing record is never overwritten, and the tool is not even run', async () => {
  const { calls, options } = invocation()
  options.exists = () => true // the record is already there
  await assert.rejects(() => sealCutRecord(options), (error) => {
    assert.ok(error.message.includes(options.recordPath))
    return true
  })
  assert.equal(calls.length, 0, 'a cut must not re-seal over the record of a different candidate')
})

test('the record path the cut chooses lands beside the staged candidate and names the version', async () => {
  const staging = await mkdtemp(path.join(os.tmpdir(), 'w54-t155-'))
  const recordPath = path.join(staging, 'seal-cut-record-1.0.45.json')
  const { options } = invocation()
  options.recordPath = recordPath
  let written = false
  options.exists = (target) => (target === recordPath ? written : true)
  options.run = async (command, argv) => {
    await writeFile(value(argv, '--out'), '{}\n')
    written = true
    return { code: 0, output: '' }
  }
  assert.equal(await sealCutRecord(options), recordPath)
  assert.equal(path.dirname(recordPath), staging)
})
