import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  loadReleaseSealControl,
  waitForReleaseSealPhase,
} from '../release-packager/cut-release-candidate.mjs'

const PHASES = [
  'worktree-materialized',
  'capability-materialized',
  'package-transition-committed',
  'dependencies-materialized',
  'build-output-materialized',
  'staged-output-materialized',
]
const CUTTER = fileURLToPath(new URL('../release-packager/cut-release-candidate.mjs', import.meta.url))

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex').toUpperCase()
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'release-seal-protocol-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const buildDirectory = path.join(root, 'build')
  await mkdir(buildDirectory)
  const cutSession = '11111111-2222-4333-8444-555555555555'
  const sourceRef = 'a'.repeat(40)
  const rows = []
  for (const [index, name] of PHASES.entries()) {
    const ackPath = path.join(root, `ack-${index}.bin`)
    const payload = Buffer.from(`authenticated-release-ack:${index}:${name}\n`, 'utf8')
    await writeFile(ackPath, Buffer.alloc(0), { flag: 'wx' })
    rows.push({ name, ackPath, ackBytes: payload.length, ackSha256: sha256(payload), payload })
  }
  const controlPath = path.join(root, 'control.json')
  const control = {
    schema: 'toolsenabled.release-seal-control',
    schemaVersion: 1,
    cutSession,
    sourceRef,
    buildDirectory,
    timeoutMilliseconds: 1_000,
    phases: rows.map(({ payload: _payload, ...row }) => row),
  }
  await writeFile(controlPath, `${JSON.stringify(control)}\n`, { encoding: 'utf8', flag: 'wx' })
  return { root, buildDirectory, cutSession, sourceRef, rows, controlPath }
}

test('seal protocol is inactive only when it was not requested', async () => {
  assert.equal(await loadReleaseSealControl(null, {
    buildDirectory: 'unused', sourceRef: 'unused', cutSession: 'unused',
  }), null)
  await waitForReleaseSealPhase(null, 'worktree-materialized')
})

test('seal protocol CLI refuses a requested control with no path', () => {
  for (const argv of [
    ['--help', '--seal-control'],
    ['--help', '--seal-control', '--test'],
  ]) {
    const result = spawnSync(process.execPath, [CUTTER, ...argv], { encoding: 'utf8', timeout: 30_000 })
    assert.notEqual(result.status, 0, `${argv.join(' ')} silently disabled the requested seal protocol`)
    assert.match(`${result.stdout}\n${result.stderr}`, /--seal-control requires one path/)
  }
})

test('seal protocol accepts six exact ordered ACKs and never prints their payload', async (t) => {
  const value = await fixture(t)
  const control = await loadReleaseSealControl(value.controlPath, value)
  const log = []
  for (const [index, name] of PHASES.entries()) {
    let ready
    const readySeen = new Promise((resolve) => { ready = resolve })
    const pending = waitForReleaseSealPhase(control, name, { log: (line) => {
      log.push(line)
      if (line.includes('SEAL READY')) ready()
    } })
    await readySeen
    await writeFile(value.rows[index].ackPath, value.rows[index].payload)
    await pending
  }
  assert.equal(control.nextPhase, PHASES.length)
  assert.equal(log.length, PHASES.length * 2)
  for (const row of value.rows) assert.equal(log.join('\n').includes(row.payload.toString('utf8').trim()), false)
})

test('seal protocol refuses a stale pre-populated ACK', async (t) => {
  const value = await fixture(t)
  await writeFile(value.rows[0].ackPath, value.rows[0].payload)
  await assert.rejects(() => loadReleaseSealControl(value.controlPath, value), /stale before protocol start/)
})

test('seal protocol refuses a reused ACK capability on a different path', async (t) => {
  const value = await fixture(t)
  const parsed = JSON.parse(await (await import('node:fs/promises')).readFile(value.controlPath, 'utf8'))
  parsed.phases[1].ackBytes = parsed.phases[0].ackBytes
  parsed.phases[1].ackSha256 = parsed.phases[0].ackSha256
  await writeFile(value.controlPath, `${JSON.stringify(parsed)}\n`)
  await assert.rejects(
    () => loadReleaseSealControl(value.controlPath, value),
    /ACK capability duplicates another phase/,
  )
})

test('seal protocol refuses wrong ACK bytes instead of waiting for a replacement', async (t) => {
  const value = await fixture(t)
  const control = await loadReleaseSealControl(value.controlPath, value)
  let ready
  const readySeen = new Promise((resolve) => { ready = resolve })
  const pending = waitForReleaseSealPhase(control, PHASES[0], { log: (line) => {
    if (line.includes('SEAL READY')) ready()
  } })
  // The reader can reject before writeFile's completion callback runs. Attach
  // the expected rejection handler before yielding to either filesystem task.
  const rejected = assert.rejects(pending, /wrong or stale/)
  await readySeen
  await writeFile(value.rows[0].ackPath, Buffer.alloc(value.rows[0].payload.length, 0x58))
  await rejected
  assert.equal(control.nextPhase, 0)
})

test('seal protocol refuses out-of-order consumption', async (t) => {
  const value = await fixture(t)
  const control = await loadReleaseSealControl(value.controlPath, value)
  await assert.rejects(
    () => waitForReleaseSealPhase(control, PHASES[1], { log: () => {} }),
    /phase order differs/,
  )
})
