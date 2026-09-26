import test from 'node:test'
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs'
import assert from 'node:assert/strict'
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { auditDrivers, looksLikeADriver } from '../check-drivers-discovered.mjs'
import { DRIVER_PATTERN, HELD_OUT_OF_DISCOVERY, HELD_OUT_POWERSHELL, staleHoldOuts } from '../packaged-qa-suite.mjs'
import { parseSourceOutput } from '../lib/adapters/source-suites.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const GATE = path.join(REPO_ROOT, 'tools', 'check-drivers-discovered.mjs')
const TEMP_ROOT = ownedFixtureTempRoot()
const QUALIFICATION_HELPERS = [
  'lib/guest/Read-InstalledState.ps1',
  'lib/transport/Probe-QualificationHost.ps1',
]

function scratchDirectory(t, prefix) {
  let current = path.parse(TEMP_ROOT).root
  for (const component of path.relative(current, TEMP_ROOT).split(path.sep)) {
    current = path.join(current, component)
    const entry = lstatSync(current)
    assert.ok(entry.isDirectory() && !entry.isSymbolicLink(), 'fixture temp ancestors must be ordinary directories')
  }
  const scratch = mkdtempSync(path.join(TEMP_ROOT, prefix))
  t.after(() => {
    assert.equal(path.dirname(path.resolve(scratch)), TEMP_ROOT, 'remove only this fixture-owned temp child')
    assert.ok(!lstatSync(scratch).isSymbolicLink(), 'never follow a replacement scratch link during cleanup')
    rmSync(scratch, { recursive: true, force: true })
  })
  return scratch
}

function writeFixture(directory, key, source = '// Inert discovery fixture; never executed.\n') {
  const file = path.join(directory, key)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, source)
  return file
}

function run(script, ...args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    env: { ...process.env, TEMP: TEMP_ROOT, TMP: TEMP_ROOT },
  })
}

test('check-drivers-discovered runs for the same file through a redundant path spelling', t => {
  const scratch = scratchDirectory(t, 'check-drivers-discovered-')
  const fixtureTools = path.join(scratch, 'tools')
  mkdirSync(fixtureTools)
  const fixtureGate = path.join(fixtureTools, path.basename(GATE))
  copyFileSync(GATE, fixtureGate)
  // Re-export the real registry and discovery implementation; no QA driver is run.
  writeFixture(fixtureTools, 'packaged-qa-suite.mjs', 'export * from ' +
    JSON.stringify(pathToFileURL(path.join(REPO_ROOT, 'tools', 'packaged-qa-suite.mjs')).href) + ';\n')
  writeFixture(fixtureTools, 'inert-qa.mjs', 'throw new Error("discovery must never execute a driver");\n')
  const undiscovered = path.join(fixtureTools, 'blind-main-guard-driver.mjs')

  try {
    writeFileSync(undiscovered, '// Deliberately shaped like a driver but absent from DRIVER_PATTERN.\n')
    const respelledGate = `${path.dirname(fixtureGate).replaceAll(path.sep, '/')}/./${path.basename(fixtureGate)}`
    const nodeArgs = ['--import', `data:text/javascript,${encodeURIComponent(`process.argv[1] = ${JSON.stringify(respelledGate)}`)}`, fixtureGate]

    const result = spawnSync(process.execPath, [...nodeArgs, '--quiet'], {
      cwd: scratch,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
      env: { ...process.env, TEMP: TEMP_ROOT, TMP: TEMP_ROOT },
    })

    assert.match(
      result.stderr,
      /look like a QA driver and are NEITHER discovered, delegated to by a discovered driver, NOR held out/,
      'the same gate respelled with a redundant /./ segment must execute main() and report the undiscovered driver',
    )
    assert.match(result.stderr, new RegExp(path.basename(undiscovered)))
    assert.equal(
      result.status,
      1,
      result.stderr || result.stdout,
    )
  } finally {
    rmSync(undiscovered, { force: true })
  }
})

test('PowerShell harnesses fail closed until an actually discovered driver delegates to them', t => {
  const scratch = scratchDirectory(t, 'check-powershell-driver-discovery-')
  const powershellName = 'installer-verification.ps1'
  const wrapperName = 'installer-verification-qa.mjs'

  writeFileSync(path.join(scratch, powershellName), 'Write-Output "PASS"\n')

  let audit = auditDrivers(scratch)
  assert.deepEqual(audit.unseen.map(entry => entry.name), [powershellName],
    'a standalone PowerShell harness must not disappear from a JavaScript-only walk')
  assert.match(audit.unseen[0].why, /PowerShell script/)
  assert.ok(looksLikeADriver(powershellName, ''),
    'PowerShell is a driver-shaped program even when its basename has no known JS driver suffix')

  writeFileSync(
    path.join(scratch, 'manual-launcher.mjs'),
    `const script = '${powershellName}'\nconsole.log(script)\n`,
  )
  writeFileSync(
    path.join(scratch, wrapperName),
    `// '${powershellName}' is deliberately only prose here.\n` +
    `const nearMatch = '${powershellName}.backup'\nconsole.log(nearMatch)\n`,
  )
  audit = auditDrivers(scratch)
  assert.deepEqual(audit.unseen.map(entry => entry.name), [powershellName],
    'a non-discovered launcher, a comment, and a longer near-match cannot manufacture reachability')

  writeFileSync(
    path.join(scratch, wrapperName),
    `const script = '${powershellName}'\nconsole.log(script)\n`,
  )
  audit = auditDrivers(scratch)
  assert.deepEqual(audit.unseen, [],
    'an exact reference in a directly discovered driver accounts for the delegated PowerShell harness')
  const powershell = audit.shaped.find(entry => entry.name === powershellName)
  assert.equal(powershell.discovered, false, 'delegation must not pretend DRIVER_PATTERN directly discovers .ps1')
  assert.deepEqual(powershell.delegatedBy, [wrapperName],
    'the audit must name the discovered driver that makes the PowerShell harness reachable')
})

test('PowerShell delegation uses exact tools-relative paths, never a nested basename exemption', t => {
  const scratch = scratchDirectory(t, 'check-powershell-relative-delegation-')
  const basename = 'installer-verification.ps1'
  const nested = 'nested/' + basename
  const other = 'elsewhere/' + basename
  for (const key of [basename, nested, other]) writeFixture(scratch, key)
  const wrapper = 'installer-verification-qa.mjs'

  writeFixture(scratch, wrapper, "const script = '" + basename + "'\n")
  let audit = auditDrivers(scratch)
  assert.deepEqual(audit.shaped.filter(entry => entry.delegatedBy.length > 0).map(entry => entry.key), [basename])
  assert.deepEqual(audit.unseen.map(entry => entry.key).sort(), [nested, other].sort())

  writeFixture(scratch, wrapper, "const script = '" + nested + "'\n")
  audit = auditDrivers(scratch)
  assert.deepEqual(audit.shaped.filter(entry => entry.delegatedBy.length > 0).map(entry => entry.key), [nested])
  assert.deepEqual(audit.unseen.map(entry => entry.key).sort(), [basename, other].sort(),
    'declaring one nested helper must not account for another path with the same name')
})

test('only the exact two qualification helper paths are held out of packaged QA', t => {
  const scratch = scratchDirectory(t, 'check-qualification-helper-scope-')
  for (const key of QUALIFICATION_HELPERS) writeFixture(scratch, key)
  const undeclared = [
    'Read-InstalledState.ps1',
    'elsewhere/Read-InstalledState.ps1',
    'lib/transport/another-probe.ps1',
    'elsewhere/Probe-QualificationHost.ps1',
  ]
  for (const key of undeclared) writeFixture(scratch, key)

  const audit = auditDrivers(scratch)
  assert.deepEqual(audit.shaped.filter(entry => entry.heldOut).map(entry => entry.key).sort(), QUALIFICATION_HELPERS)
  assert.deepEqual(audit.unseen.map(entry => entry.key).sort(), undeclared.sort())
  for (const key of QUALIFICATION_HELPERS) {
    const entry = audit.shaped.find(candidate => candidate.key === key)
    assert.equal(entry.discovered, false)
    assert.deepEqual(entry.delegatedBy, [])
    assert.match(HELD_OUT_OF_DISCOVERY.get(key), /mandatory/)
    assert.match(HELD_OUT_OF_DISCOVERY.get(key), /release.readiness/)
  }
})

test('a root-level hold-out never hides a nested copy of that driver', t => {
  const scratch = scratchDirectory(t, 'check-root-holdout-scope-')
  const rootKey = 'agent-from-ui-smoke.cjs'
  const nestedKey = 'nested/' + rootKey
  writeFixture(scratch, rootKey)
  writeFixture(scratch, nestedKey)

  const audit = auditDrivers(scratch)
  assert.equal(audit.shaped.find(entry => entry.key === rootKey).heldOut, true)
  assert.equal(audit.shaped.find(entry => entry.key === nestedKey).heldOut, false)
  assert.deepEqual(audit.unseen.map(entry => entry.key), [nestedKey])
})

test('hold-out contradictions are measured against the exact delegated path', t => {
  const scratch = scratchDirectory(t, 'check-holdout-contradictions-')
  const key = QUALIFICATION_HELPERS[0]
  const basename = path.basename(key)
  writeFixture(scratch, key)
  writeFixture(scratch, basename)
  writeFixture(scratch, 'fixture-qa.mjs', "const script = '" + basename + "'\n")
  assert.deepEqual(auditDrivers(scratch).contradictions, [],
    'a different root-level helper must not contradict a nested hold-out')

  writeFixture(scratch, 'fixture-qa.mjs', "const script = '" + key + "'\n")
  assert.deepEqual(auditDrivers(scratch).contradictions, [key],
    'a helper cannot be both delegated to by this suite and explicitly held outside it')
})

test('stale hold-outs require their exact paths even when the same basename exists elsewhere', t => {
  const scratch = scratchDirectory(t, 'check-relative-stale-holdouts-')
  for (const key of HELD_OUT_OF_DISCOVERY.keys()) writeFixture(scratch, key)
  assert.deepEqual(staleHoldOuts(scratch), [])
  for (const key of QUALIFICATION_HELPERS) {
    renameSync(path.join(scratch, key), path.join(scratch, path.basename(key)))
  }
  assert.deepEqual(staleHoldOuts(scratch).sort(), QUALIFICATION_HELPERS,
    'renaming a declared helper out of its exact nested path must leave a stale declaration')
})

test('check-drivers-discovered still passes the healthy repository', () => {
  const result = run(GATE, '--quiet')

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(result.stderr, '')
})

const DRIVER_REPORT_END = 'Every driver-shaped file under tools/ is discovered, delegated to by a discovered driver, or held out in writing.'
const DRIVER_REPORT_OPTIONS = { reporter: 'app:driver-discovery' }
const STRUCTURAL_OBSERVATION = { tests: 0, passed: 0, failed: 0, skipped: 0, cancelled: 0, todo: 0, notRun: 0 }

function driverDiscoveryReport({ discovered = 3, shaped = 7, javascript = 1, powershell = 1, pattern = DRIVER_PATTERN } = {}) {
  return `Driver discovery: ${discovered} driver(s) reached by ${pattern}; ` +
    `${shaped} driver-shaped file(s) exist under tools/; ` +
    `${javascript} JavaScript and ${powershell} PowerShell files held out with a written reason.\n` +
    `${DRIVER_REPORT_END}\n`
}

test('release qualification accepts the real discovery CLI output without claiming driver execution', () => {
  const result = run(GATE)
  assert.equal(result.error, undefined)
  assert.equal(result.signal, null)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(result.stderr, '')
  assert.deepEqual(parseSourceOutput(result.stdout, result.stderr, DRIVER_REPORT_OPTIONS), STRUCTURAL_OBSERVATION)
})

test('release discovery counts permit delegated helpers and zero holdouts without double-counting tests', () => {
  for (const population of [
    { discovered: 3, shaped: 3, javascript: 0, powershell: 0 },
    { discovered: 3, shaped: 7, javascript: 2, powershell: 2 },
    { discovered: 3, shaped: 9, javascript: 2, powershell: 2 },
    { discovered: 3, shaped: 5, javascript: 0, powershell: 0 },
  ]) {
    const report = driverDiscoveryReport(population)
    for (const output of [report, report.replaceAll('\n', '\r\n')]) {
      assert.deepEqual(parseSourceOutput(output, '', DRIVER_REPORT_OPTIONS), STRUCTURAL_OBSERVATION,
        'unallocated inventory can be delegated; discovery itself is not execution evidence')
    }
  }
})

test('release discovery rejects invalid counts and populations that exceed the shaped inventory', () => {
  const invalidPopulations = [
    { discovered: 0 }, { shaped: 0 },
    { discovered: -1 }, { shaped: -1 }, { javascript: -1 }, { powershell: -1 },
    { discovered: 1.5 }, { shaped: 7.5 }, { javascript: 0.5 }, { powershell: 0.5 },
    { javascript: 'NaN' }, { powershell: 'Infinity' },
    ...['discovered', 'shaped', 'javascript', 'powershell'].map(key => ({ [key]: Number.MAX_SAFE_INTEGER + 1 })),
    { discovered: 8 },
    { javascript: 5, powershell: 0 },
    { javascript: 0, powershell: 5 },
    { javascript: 3, powershell: 3 },
    { discovered: Number.MAX_SAFE_INTEGER, shaped: Number.MAX_SAFE_INTEGER, javascript: 1, powershell: 0 },
  ]
  for (const population of invalidPopulations) {
    assert.throws(() => parseSourceOutput(driverDiscoveryReport(population), '', DRIVER_REPORT_OPTIONS),
      { code: 'SOURCE_QUALIFICATION_INCOMPLETE' }, JSON.stringify(population))
  }
})

test('release discovery requires one current summary and its exact completion, never success prose', () => {
  const report = driverDiscoveryReport()
  const summary = report.split('\n')[0]
  const invalidReports = [
    '', 'Process exited with code 0.\n', `${summary}\n`, `${DRIVER_REPORT_END}\n`,
    `${DRIVER_REPORT_END}\n${summary}\n`,
    `${summary}\n${summary}\n${DRIVER_REPORT_END}\n`,
    `${report}${DRIVER_REPORT_END}\n`,
    `An earlier run passed.\n${report}`, `${summary}\nAn unseen driver remains.\n${DRIVER_REPORT_END}\n`,
    `${report}An unseen driver remains.\n`,
    report.replace('1 JavaScript and 1 PowerShell files', '2'),
    report.replace('1 JavaScript and 1 PowerShell files', '1 JavaScript and PowerShell files'),
    report.replace('1 JavaScript and 1 PowerShell files', '1 PowerShell and 1 JavaScript files'),
    driverDiscoveryReport({ pattern: 'everything was checked' }),
  ]
  for (const output of invalidReports) {
    assert.throws(() => parseSourceOutput(output, '', DRIVER_REPORT_OPTIONS),
      { code: 'SOURCE_QUALIFICATION_INCOMPLETE' }, output)
  }
  assert.throws(() => parseSourceOutput(report, 'An unseen driver remains.\n', DRIVER_REPORT_OPTIONS),
    { code: 'SOURCE_QUALIFICATION_INCOMPLETE' }, 'stderr findings cannot be overwritten by a success footer')
})

test('manual geometry instruments remain explicitly reported as observations, never packaged passes', () => {
  const audit = auditDrivers()
  const result = run(path.join(REPO_ROOT, 'tools', 'packaged-qa-suite.mjs'), '--list')
  assert.equal(result.status, 0, result.stderr || result.stdout)
  for (const name of ['page-width-measure.ps1', 'ledger-page-measure.ps1']) {
    const entry = audit.shaped.find(row => row.name === name)
    assert.ok(entry, `${name} must remain visible to the inventory`)
    assert.equal(entry.heldOut, true)
    assert.equal(entry.discovered, false)
    assert.deepEqual(entry.delegatedBy, [])
    const reason = HELD_OUT_POWERSHELL.get(name)
    assert.match(reason, /without asserting a layout verdict/)
    assert.match(reason, /does not inspect the packaged candidate/)
    assert.ok(result.stdout.includes(name) && result.stdout.includes(reason),
      `${name} and its reason must be printed by the real suite --list`)
  }
})
