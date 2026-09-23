// Every Hyper-V call this module makes must be BINDABLE on the host it ships
// for. A call whose named parameters span two parameter sets binds to nothing
// and throws "Parameter set cannot be resolved" BEFORE any contract check runs,
// so the qualification path is unreachable and every installed-lifecycle row
// stays unqualifiable no matter what is built above it.
//
// That is exactly what shipped: Get-VMSnapshot was called with -VM AND -Id,
// which are different sets on the Hyper-V module Windows 10 carries. The
// existing suites never caught it because THEY MOCK THE CMDLET -- a stand-in
// accepts whatever it is handed, so parameter binding was never exercised.
// This test refuses to mock: it reads the parameter sets from the REAL module
// through Get-Command and checks the source's calls against them.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const MODULE_PATH = fileURLToPath(new URL('../lib/transport/QualificationVm.psm1', import.meta.url))
const CMDLET = 'Get-VMSnapshot'

// Common parameters are legal in every set and are not part of set selection.
const COMMON = new Set(['ErrorAction', 'WarningAction', 'InformationAction', 'ProgressAction', 'Verbose', 'Debug',
  'ErrorVariable', 'WarningVariable', 'InformationVariable', 'OutVariable', 'OutBuffer', 'PipelineVariable', 'WhatIf', 'Confirm'])

// Named parameters of each call, in source order. Deliberately a source read
// and not an execution: the point is to catch an unbindable call without
// running it against a live machine.
function callsIn(source, cmdlet) {
  const calls = []
  const pattern = new RegExp(String.raw`\b${cmdlet}\b([^\r\n]*)`, 'g')
  for (const match of source.matchAll(pattern)) {
    const tail = match[1]
    if (/^\s*(\}|#)/.test(tail)) continue
    const named = [...tail.matchAll(/-([A-Za-z][A-Za-z0-9]*)/g)]
      .map(m => m[1])
      .filter(name => !COMMON.has(name))
    calls.push({ named, text: `${cmdlet}${tail}`.trim() })
  }
  return calls
}

// The host's own answer about what binds. No table of ours is consulted.
function parameterSetsFromHost(cmdlet) {
  const script = `$ErrorActionPreference='Stop'
if (-not (Get-Command ${cmdlet} -ErrorAction SilentlyContinue)) { '{"available":false}'; exit 0 }
$sets = @((Get-Command ${cmdlet}).ParameterSets | ForEach-Object {
  @{ name = $_.Name; parameters = @($_.Parameters | ForEach-Object { $_.Name }) } })
@{ available = $true; sets = $sets } | ConvertTo-Json -Depth 5 -Compress`
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', timeout: 60000 })
  if (run.error || run.status !== 0) return { available: false, why: run.error?.message || run.stderr || `exit ${run.status}` }
  try { return JSON.parse(run.stdout) } catch { return { available: false, why: `unparsable: ${run.stdout.slice(0, 200)}` } }
}

test('every Get-VMSnapshot call in the qualification module binds to one real parameter set', () => {
  const source = readFileSync(MODULE_PATH, 'utf8')
  const calls = callsIn(source, CMDLET)
  assert.ok(calls.length > 0, `no ${CMDLET} call found in the module; the test is pointed at the wrong file`)

  if (process.platform !== 'win32') {
    // Named skip, not a silent pass: an absent module is not a passing check.
    console.log(`# SKIP parameter binding is a Windows question and this host is ${process.platform}`)
    return
  }
  const host = parameterSetsFromHost(CMDLET)
  if (!host.available) {
    console.log(`# SKIP the Hyper-V module does not provide ${CMDLET} on this host: ${host.why ?? 'cmdlet absent'}`)
    return
  }

  const sets = host.sets.map(set => ({ name: set.name, parameters: new Set(set.parameters) }))
  assert.ok(sets.length > 0, `${CMDLET} reported no parameter sets`)

  for (const call of calls) {
    const fits = sets.filter(set => call.named.every(name => set.parameters.has(name)))
    assert.ok(fits.length > 0,
      `${CMDLET} is called with -${call.named.join(' -')} but no single parameter set accepts that combination, ` +
      `so this call binds to nothing and throws before any contract check runs. ` +
      `Sets on this host: ${sets.map(s => `${s.name}(${[...s.parameters].join(',')})`).join(' | ')}. ` +
      `Call: ${call.text}`)
  }
})
