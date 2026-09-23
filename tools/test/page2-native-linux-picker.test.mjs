import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const helper = fileURLToPath(new URL('../lib/page2-native-picker.py', import.meta.url))

test('Linux native picker validates its actual owning process and QA paths before any desktop input', { skip: process.platform !== 'linux' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'page2-native-picker-'))
  const request = path.join(directory, 'request.json')
  const result = path.join(directory, 'result.json')
  const image = path.join(directory, 'image.png')
  const profile = path.join(directory, 'profile')
  const launch = path.join(directory, 'launch.json')
  fs.mkdirSync(profile)
  fs.writeFileSync(image, 'owned fixture')
  fs.writeFileSync(request, JSON.stringify({ operation: 'select-path', title: 'QA dialog', selectedPath: image }))
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', `--user-data-dir=${path.join(directory, 'profile')}`], { stdio: 'ignore' })
  await once(child, 'spawn')
  const fields = fs.readFileSync(`/proc/${child.pid}/stat`, 'utf8').split(')').at(-1).trim().split(/\s+/)
  const identity = { qaProcessId: child.pid, runnerPid: process.pid, startTicks: fields[19], userData: profile }
  fs.writeFileSync(launch, JSON.stringify(identity))
  const args = ['--qa-root', directory, '--expected-profile-root', os.homedir(), '--qa-process-id', String(child.pid), '--request-path', request, '--result-path', result, '--launch-record', launch, '--validate-only']
  const run = extra => spawnSync('/usr/bin/python3', [helper, ...args, ...extra], { encoding: 'utf8' })
  try {
    const valid = run([])
    assert.equal(valid.status, 0, valid.stderr)
    assert.deepEqual(JSON.parse(fs.readFileSync(result)), { ok: true, validationOnly: true, nativeInputSent: false })
    const wrongProcess = run(['--qa-process-id', String(process.pid)])
    assert.notEqual(wrongProcess.status, 0)
    assert.match(wrongProcess.stderr, /recorded OS start time/)
    fs.writeFileSync(launch, JSON.stringify({ ...identity, startTicks: '0' }))
    assert.match(run([]).stderr, /recorded OS start time/)
    fs.writeFileSync(launch, JSON.stringify(identity))
    const wrongAccount = run(['--expected-profile-root', path.join(directory, 'foreign')])
    assert.notEqual(wrongAccount.status, 0)
    assert.match(wrongAccount.stderr, /expected current account/)
    fs.writeFileSync(request, JSON.stringify({ operation: 'select-path', title: 'QA dialog', selectedPath: path.join(os.tmpdir(), 'outside-do-not-open.png') }))
    assert.match(run([]).stderr, /inside QA storage/)
    fs.writeFileSync(request, JSON.stringify({ operation: 'cancel', title: 'QA dialog', padding: 'x'.repeat(65536) }))
    assert.match(run([]).stderr, /exceeds 64 KiB/)
  } finally {
    const ended = once(child, 'exit')
    child.kill()
    await ended
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
