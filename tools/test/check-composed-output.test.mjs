// Behavioural tests for the composed-output release gate. These invoke the
// executable rather than importing its implementation, so an exit-code defect
// cannot be hidden by assertions against code that never runs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const GATE = join(REPO, 'tools', 'check-composed-output.mjs')

function runGate(gate = GATE) {
  const result = spawnSync(process.execPath, [gate], { encoding: 'utf8' })
  return {
    status: result.status,
    output: `${result.stdout || ''}${result.stderr || ''}`,
  }
}

function withFixture(composedPanelsSource, findingsSource, body) {
  const root = mkdtempSync(join(tmpdir(), 'te-composed-output-'))
  try {
    const tools = join(root, 'tools')
    const lib = join(tools, 'lib')
    mkdirSync(lib, { recursive: true })
    copyFileSync(GATE, join(tools, 'check-composed-output.mjs'))
    writeFileSync(join(lib, 'composed-panels.mjs'), `export async function composedPanels() { ${composedPanelsSource} }\n`)
    writeFileSync(join(lib, 'composed-output-rules.mjs'), [
      "export const COMPOSED_RULES = ['fixture-rule']",
      `export function findingsInPanel(panel) { ${findingsSource} }`,
      '',
    ].join('\n'))
    return body(join(tools, 'check-composed-output.mjs'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('check-composed-output passes after inspecting the repository panel matrix', () => {
  const { status, output } = runGate()
  assert.equal(status, 0, `expected exit 0, got ${status}:\n${output}`)
  assert.match(output, /Composed output: \d+ panel state\(s\), \d+ visible string\(s\) on screen together; 0 finding\(s\)/)
  assert.match(output, /Every panel tells one story in every state it can be in\./)
})

test('check-composed-output still executes when reached through a linked directory lane', () => {
  const root = mkdtempSync(join(tmpdir(), 'te-composed-output-lane-'))
  try {
    const lane = join(root, 'TOOLS-LANE')
    symlinkSync(dirname(GATE), lane, process.platform === 'win32' ? 'junction' : 'dir')
    const { status, output } = runGate(join(lane, 'check-composed-output.mjs'))
    assert.equal(status, 0, `expected the linked invocation to execute and pass, got ${status}:\n${output}`)
    assert.match(output, /Composed output: \d+ panel state\(s\)/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('check-composed-output refuses an empty panel enumeration', () => {
  withFixture('return []', 'return []', gate => {
    const { status, output } = runGate(gate)
    assert.equal(status, 2, `an empty enumeration must be a setup failure, got ${status}:\n${output}`)
    assert.equal(output, 'SETUP: only 0 panel state(s) were built, and 6 is the floor. An empty matrix is not a clean run.\n')
  })
})

test('check-composed-output refuses a missing builder input', () => {
  const root = mkdtempSync(join(tmpdir(), 'te-composed-output-missing-'))
  try {
    const gate = join(root, 'check-composed-output.mjs')
    copyFileSync(GATE, gate)
    const { status, output } = runGate(gate)
    assert.notEqual(status, 0, `missing imported inputs must not produce a green exit:\n${output}`)
    assert.match(output, /ERR_MODULE_NOT_FOUND|Cannot find module/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('check-composed-output exits 1 when a rule finds broken composition', () => {
  const panels = `return Array.from({ length: 6 }, (_, index) => ({
    panel: 'fixture-panel', state: String(index), why: 'fixture', list: null,
    slots: [{ name: 'message', tone: 'neutral', text: 'visible' }],
  }))`
  const finding = "return panel.state === '0' ? [{ rule: 'fixture-rule', detail: 'two stories', excerpt: 'broken composition' }] : []"
  withFixture(panels, finding, gate => {
    const { status, output } = runGate(gate)
    assert.equal(status, 1, `a finding must fail the gate, got ${status}:\n${output}`)
    assert.match(output, /1 finding\(s\) \[fixture-rule=1\]/)
    assert.match(output, /fixture-panel · 0: \[fixture-rule\] two stories/)
  })
})
