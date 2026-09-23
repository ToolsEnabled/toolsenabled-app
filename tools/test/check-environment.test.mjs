// Behavioural tests for the environment doctor. These run the actual gate:
// the assertion is about its exit status, not text in its source.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const GATE = join(REPO, 'tools', 'check-environment.mjs')
const PRIVATE_DIR = join(REPO, 'private')
const PIN_FILE = join(PRIVATE_DIR, 'capability-source.owner.json')

function withGateFixture(pin, body) {
  const home = mkdtempSync(join(tmpdir(), 'check-environment-'))
  const hadPrivateDir = existsSync(PRIVATE_DIR)
  const hadPin = existsSync(PIN_FILE)
  const originalPin = hadPin ? readFileSync(PIN_FILE) : undefined

  try {
    mkdirSync(join(home, 'Desktop', 'ToolsEnabled-INSTALLER-CANDIDATE'), { recursive: true })
    if (pin !== undefined) {
      mkdirSync(PRIVATE_DIR, { recursive: true })
      writeFileSync(PIN_FILE, pin)
    } else {
      rmSync(PIN_FILE, { force: true })
    }
    return body(home)
  } finally {
    if (hadPin) writeFileSync(PIN_FILE, originalPin)
    else rmSync(PIN_FILE, { force: true })
    if (!hadPrivateDir) rmSync(PRIVATE_DIR, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
}

function runGate(home) {
  const result = spawnSync(process.execPath, [GATE], {
    cwd: REPO,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
  })
  return { status: result.status, out: `${result.stdout || ''}${result.stderr || ''}` }
}

test('check-environment refuses a pin file that names no payload source', () => {
  withGateFixture('{}\n', (home) => {
    const { status, out } = runGate(home)
    assert.notEqual(status, 0, `gate passed without inspecting a payload source:\n${out}`)
    assert.match(out, /FAIL  private\/capability-source\.owner\.json does not name a payload source path; the build input cannot be checked\./)
  })
})

test('check-environment still passes a healthy contributor checkout', () => {
  withGateFixture(undefined, (home) => {
    const { status, out } = runGate(home)
    assert.equal(status, 0, `healthy gate failed with exit ${status}:\n${out}`)
    assert.match(out, /Everything this checkout needs is in place\./)
  })
})
