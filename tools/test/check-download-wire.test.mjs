import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { peIdentityViolations } from '../check-download-wire.mjs'
import identity from '../../shell/installer-pe-identity.cjs'

const { readExeVersionInfo, releaseVersionFromPe } = identity

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const GATE = path.join(ROOT, 'tools', 'check-download-wire.mjs')
// The trusted PE resource reader is a Windows OS operation. These two
// subprocess controls must run there with a real PE, never Linux's ELF node
// renamed to .exe. All platform-independent declaration/refusal checks run
// on both systems; a Linux skip is not Windows publication evidence.
const NATIVE_PE_TEST = { skip: process.platform === 'win32' ? false : 'Native Windows PE resource proof: must execute on Windows before publication' }

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'check-download-wire-'))
  const dist = path.join(root, 'dist')
  const candidates = path.join(root, 'candidates')
  mkdirSync(dist)
  mkdirSync(candidates)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { dist, candidates }
}

function run(...args) {
  return spawnSync(process.execPath, [GATE, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  })
}

async function stageHealthy({ dist, candidates }) {
  const filename = 'Product.exe'
  writeFileSync(path.join(dist, 'index.html'), `<a href="${filename}">Download</a>\n`)
  const candidate = path.join(candidates, filename)
  copyFileSync(process.execPath, candidate)
  const bytes = readFileSync(candidate)
  const pe = await readExeVersionInfo(candidate)
  const version = releaseVersionFromPe(pe.productVersion)
  const manifest = {
    filename,
    version,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    productName: pe.productName,
    fileVersion: pe.fileVersion,
    productVersion: pe.productVersion,
    buildRef: '0123456789abcdef0123456789abcdef01234567',
    publisher: 'Publisher',
    appId: 'com.example.product',
    immutableLocation: '/frozen/Product.exe',
  }
  writeFileSync(path.join(dist, 'download.json'), JSON.stringify(manifest))
  return manifest
}

test('check-download-wire refuses an undeclared extra installer in the candidate inventory', NATIVE_PE_TEST, async (t) => {
  const staged = fixture(t)
  await stageHealthy(staged)
  const extra = path.join(staged.candidates, 'Surprise.exe')
  writeFileSync(extra, 'undeclared bytes\n')

  const result = run(staged.dist, '--manifest', path.join(staged.dist, 'download.json'), '--candidate-root', staged.candidates)

  assert.equal(result.status, 1, `blind pass: ${result.stdout}${result.stderr}`)
  assert.match(result.stderr, /UNDECLARED CANDIDATE FOUND/)
  assert.match(result.stderr, /Surprise\.exe/)
})

test('check-download-wire refuses a present declaration that contains JSON null', (t) => {
  const staged = fixture(t)
  writeFileSync(path.join(staged.dist, 'index.html'), '<main>No download</main>\n')
  writeFileSync(path.join(staged.dist, 'download.json'), 'null\n')

  const result = run(staged.dist, '--manifest', path.join(staged.dist, 'download.json'))

  assert.equal(result.status, 1, `blind pass: ${result.stdout}${result.stderr}`)
  assert.match(result.stderr, /DECLARATION MALFORMED/)
  assert.match(result.stderr, /must be a JSON object/)
})

test('check-download-wire still passes a healthy declared candidate and matching offer', NATIVE_PE_TEST, async (t) => {
  const staged = fixture(t)
  await stageHealthy(staged)

  const result = run(staged.dist, '--manifest', path.join(staged.dist, 'download.json'), '--candidate-root', staged.candidates)

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
  assert.match(result.stdout, /OK: download offer is backed by a complete, verified declaration\./)
  assert.equal(result.stderr, '')
})

test('check-download-wire identifies the wrong 1.0.32 PE even when the manifest claims 1.0.39', () => {
  const manifest = {
    version: '1.0.39',
    productName: 'ToolsEnabled',
    fileVersion: '1.0.39',
    productVersion: '1.0.39',
  }
  const violations = peIdentityViolations({
    manifest,
    measured: {
      productName: 'ToolsEnabled',
      fileVersion: '1.0.32',
      productVersion: '1.0.32',
    },
    candidate: 'wrong-1.0.32.exe',
  })

  assert.equal(violations.length, 2)
  assert.match(violations.join('\n'), /fileVersion declared "1\.0\.39", measured "1\.0\.32"/)
  assert.match(violations.join('\n'), /productVersion declared "1\.0\.39", measured "1\.0\.32"/)
})
