import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createPackage } from '@electron/asar'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const GATE = path.join(REPO_ROOT, 'tools', 'check-asar-manifest.mjs')

test('check-asar-manifest refuses a missing archive when invoked through a symlinked lane', () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'check-asar-manifest-'))
  try {
    const lane = path.join(fixture, 'lane')
    symlinkSync(REPO_ROOT, lane, process.platform === 'win32' ? 'junction' : 'dir')
    const missingBuild = path.join(fixture, 'missing-build')
    const linkedGate = path.join(lane, 'tools', 'check-asar-manifest.mjs')

    const result = spawnSync(process.execPath, [linkedGate, missingBuild], {
      encoding: 'utf8',
      windowsHide: true,
    })

    assert.equal(result.status, 1, `gate unexpectedly passed without looking:\n${result.stdout}${result.stderr}`)
    assert.equal(result.stdout, '')
    assert.match(
      result.stderr,
      new RegExp(`^check-asar-manifest: no archive at ${escapeRegExp(path.join(missingBuild, 'resources', 'app.asar'))}`),
    )
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('check-asar-manifest refuses a build.files directory it could not enumerate', async () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'check-asar-manifest-empty-'))
  try {
    const tools = path.join(fixture, 'tools')
    const app = path.join(fixture, 'app')
    const build = path.join(fixture, 'build')
    mkdirSync(tools)
    mkdirSync(path.join(app, 'present'), { recursive: true })
    mkdirSync(path.join(app, 'dist'), { recursive: true })
    mkdirSync(path.join(build, 'resources', 'capability'), { recursive: true })
    copyFileSync(GATE, path.join(tools, 'check-asar-manifest.mjs'))
    writeJson(path.join(fixture, 'package.json'), { build: { files: ['present/**', 'missing/**'] } })
    writeJson(path.join(app, 'package.json'), { main: 'present/main.cjs' })
    writeFileSync(path.join(app, 'present', 'main.cjs'), '')
    writeJson(path.join(app, 'dist', 'build-info.json'), { ref: '0123456789abcdef', dirty: false })
    await createPackage(app, path.join(build, 'resources', 'app.asar'))
    writeJson(path.join(build, 'resources', 'capability', 'PAYLOAD.json'), {
      bridgeEntrypoint: 'bridge.cjs', ownerHostModule: 'src/owner-host.js', fileCount: 2,
      hostModules: ['src/owner-host.js'], ownerDataClean: true,
    })
    writeFileSync(path.join(build, 'resources', 'capability', 'bridge.cjs'), '')
    mkdirSync(path.join(build, 'resources', 'capability', 'src'), { recursive: true })
    writeFileSync(path.join(build, 'resources', 'capability', 'src', 'owner-host.js'), '')

    const result = spawnSync(process.execPath, [path.join(tools, 'check-asar-manifest.mjs'), build], {
      encoding: 'utf8', windowsHide: true,
    })
    assert.equal(result.status, 1, `gate unexpectedly passed an unread source directory:\n${result.stdout}${result.stderr}`)
    assert.match(result.stderr, /build\.files declares source directories that do not exist[\s\S]*missing/)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value)}\n`)
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
