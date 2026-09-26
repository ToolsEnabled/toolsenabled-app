import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const gate = path.join(repoRoot, 'tools', 'check-deep-walk-due.mjs')

test('check-deep-walk-due runs for the same file through a redundant path spelling', () => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'check-deep-walk-due-'))
  try {
    const tools = path.join(fixture, 'tools')
    mkdirSync(tools)
    const fixtureGate = path.join(tools, 'check-deep-walk-due.mjs')
    writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ type: 'module', version: '1.0.31' }))
    writeFileSync(fixtureGate, readFileSync(gate))
    const respelledGate = `${path.dirname(fixtureGate).replaceAll(path.sep, '/')}/./${path.basename(fixtureGate)}`
    const nodeArgs = ['--import', `data:text/javascript,${encodeURIComponent(`process.argv[1] = ${JSON.stringify(respelledGate)}`)}`, fixtureGate]

    const result = spawnSync(process.execPath, [...nodeArgs, '--strict'], { encoding: 'utf8' })

    assert.match(
      result.stdout,
      /^A DEEP WALK IS DUE\. no deep walk has ever been recorded/,
      'the same gate respelled with a redundant /./ segment must execute main() and report the overdue walk',
    )
    assert.equal(
      result.status,
      1,
      result.stderr,
    )

    const healthy = spawnSync(process.execPath, [fixtureGate, '--strict'], { encoding: 'utf8' })
    assert.equal(healthy.status, 1, healthy.stderr)
    assert.equal(healthy.stdout, result.stdout)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('check-deep-walk-due still passes a recently walked tree', () => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'check-deep-walk-due-'))
  try {
    const tools = path.join(fixture, 'tools')
    mkdirSync(tools)
    writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ type: 'module', version: '1.0.31' }))
    writeFileSync(path.join(tools, 'check-deep-walk-due.mjs'), readFileSync(gate))
    execFileSync(process.execPath, [path.join(tools, 'check-deep-walk-due.mjs'), '--record'])

    const result = spawnSync(process.execPath, [path.join(tools, 'check-deep-walk-due.mjs'), '--strict'], { encoding: 'utf8' })

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /^No deep walk needed yet\. 1\.0\.31 was walked on/)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})
