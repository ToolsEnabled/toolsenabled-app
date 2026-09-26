/* The packer's three new refusals, exercised in isolation.
 *
 * Each assertion below names the exact rule it protects, because these guards
 * all fail the build with the same coarse outcome (a thrown Error) and a shared
 * message would let a mutant that broke the vault rule die looking like one that
 * broke the extension rule. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MessageChannel, Worker } from 'node:worker_threads'
import test from 'node:test'

import {
  HELPER_PROGRAM_EXTENSIONS,
  assertHelperProgramsAreExecutable,
  assertManagedProcessEntrypointShipped,
  assertManagedProcessEntrypointsShipped,
  assertNoSecretMaterial,
  computeClosure,
  computePowerShellClosure,
} from '../pack-capability-layer.mjs'

async function temporaryTree(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'pack-guard-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10 }))
  return root
}

test('S1 - the vault CONTENTS are refused while the vault SCRIPT is allowed', () => {
  assert.doesNotThrow(
    () => assertNoSecretMaterial(['tools/secrets.ps1', 'tools/owner-prompt-theme.ps1', 'config/model-floor.json']),
    'tools/secrets.ps1 is a program and must be stageable; refusing it would re-break the installer this guard exists to fix',
  )

  assert.throws(
    () => assertNoSecretMaterial(['tools/secrets.ps1', 'vault/secrets.json']),
    (error) => {
      assert.match(error.message, /vault\/secrets\.json/, 'the offending path must be named')
      assert.match(error.message, /under a vault\/ directory/, 'the reason must say which rule refused it')
      return true
    },
    'vault/secrets.json must never be stageable: shipping it hands every customer the builder credentials',
  )
})

test('S2 - runtime state and other credential-shaped paths are refused whatever list named them', () => {
  const refused = [
    ['state/mission-bridge-token.json', /under a state\/ directory/],
    ['private/capability-source.owner.json', /under a private\/ directory/],
    ['reports/OWNER-REQUEST-LEDGER.json', /under a reports\/ directory/],
    ['config/auth.json', /named auth\.json/],
    ['certs/server.pem', /\.pem file/],
    ['state/audit.sqlite3', /under a state\/ directory/],
  ]
  for (const [candidate, reason] of refused) {
    assert.throws(
      () => assertNoSecretMaterial([candidate]),
      (error) => {
        assert.match(error.message, reason, `${candidate} must be refused for the stated reason, not incidentally`)
        return true
      },
      `${candidate} must be refused by assertNoSecretMaterial`,
    )
  }
})

test('S3 - a helperPrograms entry that is not an executable helper is refused', () => {
  assert.doesNotThrow(
    () => assertHelperProgramsAreExecutable(['tools/secrets.ps1', 'tools/playwright-mcp.cmd', 'research/extract.py']),
    'the three helper kinds this payload actually ships must all be accepted',
  )

  assert.throws(
    () => assertHelperProgramsAreExecutable(['config/settings-registry.json']),
    (error) => {
      assert.match(error.message, /config\/settings-registry\.json/)
      assert.match(error.message, /dataFiles/, 'the refusal must point at the category the file does belong in')
      return true
    },
    'JSON must not be smuggled through helperPrograms, where the data-file rules would not apply to it',
  )

  assert.throws(
    () => assertHelperProgramsAreExecutable(['src/job-runner.js']),
    (error) => {
      assert.match(error.message, /spawnedPrograms/, 'JavaScript must be redirected to the list whose closure is walked')
      return true
    },
    'JavaScript in helperPrograms would be copied without walking its require() graph',
  )

  assert.ok(HELPER_PROGRAM_EXTENSIONS.has('.ps1'), 'PowerShell must remain an accepted helper kind')
})

test('S4 - the PowerShell closure follows a dot-source written as Join-Path $PSScriptRoot', async (t) => {
  const root = await temporaryTree(t)
  await mkdir(path.join(root, 'tools'), { recursive: true })
  // The exact spelling secrets.ps1 uses at line 736. A walk that matched only
  // `$PSScriptRoot\name` reported a clean pack over this file.
  await writeFile(
    path.join(root, 'tools', 'seed.ps1'),
    ". (Join-Path $PSScriptRoot 'theme.ps1')\n",
  )
  await writeFile(path.join(root, 'tools', 'theme.ps1'), '# shared theme\n')

  const closure = computePowerShellClosure(root, ['tools/seed.ps1'])
  assert.deepEqual(closure.unresolved, [], 'a dot-source that exists on disk must not be reported unresolved')
  assert.deepEqual(
    closure.files,
    ['tools/seed.ps1', 'tools/theme.ps1'],
    'Join-Path $PSScriptRoot dot-sourcing must be followed, or the vault ships without the file it dot-sources',
  )
})

test('S5 - the PowerShell closure also follows the $PSScriptRoot\\name form, and transitively', async (t) => {
  const root = await temporaryTree(t)
  await mkdir(path.join(root, 'tools'), { recursive: true })
  await writeFile(path.join(root, 'tools', 'seed.ps1'), '. "$PSScriptRoot\\middle.ps1"\n')
  await writeFile(path.join(root, 'tools', 'middle.ps1'), ". (Join-Path $PSScriptRoot 'leaf.ps1')\n")
  await writeFile(path.join(root, 'tools', 'leaf.ps1'), '# leaf\n')

  const closure = computePowerShellClosure(root, ['tools/seed.ps1'])
  assert.deepEqual(
    closure.files,
    ['tools/leaf.ps1', 'tools/middle.ps1', 'tools/seed.ps1'],
    'the PowerShell walk must be transitive; a helper two dot-sources deep is as absent as one',
  )
})

test('S6 - a dot-source that does not exist is reported, never silently dropped', async (t) => {
  const root = await temporaryTree(t)
  await mkdir(path.join(root, 'tools'), { recursive: true })
  await writeFile(path.join(root, 'tools', 'seed.ps1'), ". (Join-Path $PSScriptRoot 'absent.ps1')\n")

  const closure = computePowerShellClosure(root, ['tools/seed.ps1'])
  assert.deepEqual(
    closure.unresolved,
    [{ from: 'tools/seed.ps1', spec: 'tools/absent.ps1' }],
    'an unresolvable dot-source must fail the pack, not ship a helper that throws CommandNotFoundException',
  )
})

test('S7 - non-PowerShell helpers are carried without being walked', async (t) => {
  const root = await temporaryTree(t)
  await mkdir(path.join(root, 'tools'), { recursive: true })
  await writeFile(path.join(root, 'tools', 'shim.cmd'), '@echo off\n')

  const closure = computePowerShellClosure(root, ['tools/shim.cmd', 'research/extract.py'])
  assert.deepEqual(closure.files, [], 'a .cmd or .py has no dot-source graph to walk and must not be treated as a seed')
  assert.deepEqual(closure.unresolved, [], 'skipping a non-PowerShell helper is not an unresolved reference')
})

test('S8 - the Windows Job Object wrapper is an explicit shipped helper', async () => {
  const manifest = JSON.parse(await readFile(new URL('../capability-manifest.json', import.meta.url), 'utf8'))
  assert.ok(
    manifest.helperPrograms.includes('tools/windows-job-wrapper.ps1'),
    'the JavaScript closure cannot discover the computed PowerShell path; omitting it ships timeout cleanup without its kernel boundary',
  )
})

test('S9 - optional managed processes cannot name programs the payload does not ship', async () => {
  const defaults = JSON.parse(await readFile(
    new URL('../../capability-defaults/config/managed-processes.json', import.meta.url),
    'utf8',
  ))
  assert.deepEqual(
    assertManagedProcessEntrypointShipped(defaults, 'fleet-supervisor', new Set()),
    { declared: false },
    'the fresh-install registry must not advertise the omitted builder fleet supervisor',
  )

  const manifest = JSON.parse(await readFile(new URL('../capability-manifest.json', import.meta.url), 'utf8'))
  for (const processId of ['dashboard', 'uac-delegation-helper']) {
    assert.deepEqual(
      assertManagedProcessEntrypointShipped(defaults, processId, new Set()),
      { declared: false },
      `the fresh-install registry must represent the uninstalled ${processId} process as unavailable`,
    )
  }
  for (const processId of ['dashboard']) {
    assert.equal(
      defaults.processes[processId].correctionMode,
      'report-only',
      `${processId} must remain report-only when it is not installed`,
    )
  }
  assert.equal(
    manifest.spawnedPrograms.includes('src/uac-delegation-helper.js'),
    false,
    'shipping only the UAC JavaScript file would advertise an elevated helper without its registrar or packaged-runtime task action',
  )

  const falseAdvertisement = structuredClone(defaults)
  falseAdvertisement.processes['fleet-supervisor'].entryPoint = 'tools/fleet-supervisor.js'
  falseAdvertisement.processes['fleet-supervisor'].entryPattern = 'tools/fleet-supervisor.js'
  assert.throws(
    () => assertManagedProcessEntrypointShipped(falseAdvertisement, 'fleet-supervisor', new Set()),
    (error) => {
      assert.match(error.message, /fleet-supervisor/)
      assert.match(error.message, /absent from the staged payload/)
      assert.match(error.message, /closure root|leave the optional entryPoint/)
      return true
    },
    'a JSON-only source-tree path must not become an installed process claim',
  )

  assert.deepEqual(
    assertManagedProcessEntrypointShipped(
      falseAdvertisement,
      'fleet-supervisor',
      new Set(['tools/fleet-supervisor.js']),
    ),
    { declared: true, entryPoint: 'tools/fleet-supervisor.js' },
    'the declaration may return only when the program really belongs to the staged closure',
  )

  for (const [field, value] of [
    ['entryPoint', 'tools/fleet-supervisor.js'],
    ['entryPattern', 'tools/fleet-supervisor.js'],
  ]) {
    const halfDeclared = structuredClone(defaults)
    halfDeclared.processes['fleet-supervisor'][field] = value
    assert.throws(
      () => assertManagedProcessEntrypointShipped(halfDeclared, 'fleet-supervisor', new Set()),
      /must leave both entryPoint and entryPattern empty/,
      `an optional process cannot declare only ${field}`,
    )
  }

  assert.throws(
    () => assertManagedProcessEntrypointsShipped({ schemaVersion: 1, processes: {} }, new Set()),
    /declares zero processes/,
    'an empty registry would make the installed loader fail and cannot pass the packer as vacuous success',
  )
  assert.throws(
    () => assertManagedProcessEntrypointsShipped({ schemaVersion: 1 }, new Set()),
    /must declare a processes object/,
    'a missing processes object cannot pass the packer as vacuous success',
  )

  const registrarWithoutEntrypoint = structuredClone(defaults)
  registrarWithoutEntrypoint.processes['fleet-supervisor'].registrar = 'tools/fleet-supervisor-task.ps1'
  assert.throws(
    () => assertManagedProcessEntrypointShipped(registrarWithoutEntrypoint, 'fleet-supervisor', new Set()),
    /registrar .* absent from the staged payload/,
    'an unavailable process cannot smuggle an unstaged registrar past the empty-entrypoint return',
  )
})

test('S10 - the coordinator duty host ships as one complete managed process', async (t) => {
  const defaults = JSON.parse(await readFile(
    new URL('../../capability-defaults/config/managed-processes.json', import.meta.url),
    'utf8',
  ))
  const manifest = JSON.parse(await readFile(new URL('../capability-manifest.json', import.meta.url), 'utf8'))
  const process = defaults.processes['coordinator-duty-host']

  assert.ok(process, 'the fresh-install registry must declare the durable coordinator host')
  assert.equal(process.entryPoint, 'tools/coordinator-duty-host.js')
  assert.deepEqual(process.declaredArgv, ['--serve'], 'the scheduled task must not silently gain --allow-restart')
  assert.equal(process.registrar, 'tools/coordinator-duty-host-task.ps1')
  assert.ok(manifest.spawnedPrograms.includes(process.entryPoint), 'the host JavaScript must be a walked closure root')
  assert.ok(
    manifest.spawnedPrograms.includes('tools/resolve-node.js'),
    'the PowerShell node resolver\'s JavaScript authority must be a walked closure root',
  )
  assert.ok(manifest.helperPrograms.includes(process.registrar), 'the fixed scheduled-task registrar must ship')

  assert.deepEqual(
    assertManagedProcessEntrypointShipped(defaults, 'coordinator-duty-host', new Set([
      process.entryPoint,
      process.registrar,
    ])),
    { declared: true, entryPoint: process.entryPoint },
  )

  const missingRegistrar = structuredClone(defaults)
  assert.throws(
    () => assertManagedProcessEntrypointShipped(missingRegistrar, 'coordinator-duty-host', new Set([process.entryPoint])),
    /registrar .* absent from the staged payload/,
    'a managed host without its registrar is not an installed durable process',
  )

  // capability/ is generated. Before a pack it can legitimately describe the
  // preceding manifest, so use PAYLOAD.json to distinguish that state from a
  // current pack. Once the record matches these roots, every assertion below
  // is mandatory and reads the actual staged bytes the installer will ship.
  let payloadBytes
  try {
    payloadBytes = await readFile(new URL('../../capability/PAYLOAD.json', import.meta.url), 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    return t.skip('capability/ is not staged; pack the source to exercise the installed PowerShell closure')
  }
  const payload = JSON.parse(payloadBytes)
  const payloadIsCurrent = (
    JSON.stringify(payload.spawnedPrograms) === JSON.stringify(manifest.spawnedPrograms)
    && JSON.stringify(payload.helperPrograms) === JSON.stringify(manifest.helperPrograms)
    && JSON.stringify(payload.neutralDefaults) === JSON.stringify(manifest.neutralDefaults)
  )
  if (!payloadIsCurrent) {
    return t.skip('capability/ predates the current manifest; pack the source to exercise the installed PowerShell closure')
  }

  const stagedRoot = fileURLToPath(new URL('../../capability/', import.meta.url))
  const stagedPowerShell = computePowerShellClosure(stagedRoot, [process.registrar])
  assert.deepEqual(stagedPowerShell.unresolved, [], 'the staged coordinator registrar must resolve its complete PowerShell closure')
  for (const dependency of ['tools/lib/resolve-node.ps1', 'tools/lib/StartupPolicy.ps1']) {
    assert.ok(stagedPowerShell.files.includes(dependency), `${dependency} must exist in the actual packed closure`)
  }
  const stagedResolver = await readFile(path.join(stagedRoot, 'tools', 'resolve-node.js'), 'utf8')
  assert.match(stagedResolver, /resolveQualifyingNode/, 'the actual packed closure must include the Node qualification authority')
})

test('S11 - the persistent vault worker and its helper ship as a complete, runnable closure', async (t) => {
  const workerRelative = 'src/lib/vault-host/worker.js'
  const helperRelative = 'tools/vault-host.ps1'
  const manifest = JSON.parse(await readFile(new URL('../capability-manifest.json', import.meta.url), 'utf8'))
  assert.ok(manifest.spawnedPrograms.includes(workerRelative), 'a computed Worker path must be a walked closure root')
  assert.ok(manifest.helperPrograms.includes(helperRelative), 'the worker must not ship without the PowerShell program it starts')

  // This is a staged-byte gate, not a source-tree claim. A stale or missing
  // pack must fail until repacked; no checkout fallback can satisfy it.
  const stagedRoot = fileURLToPath(new URL('../../capability/', import.meta.url))
  const payload = JSON.parse(await readFile(path.join(stagedRoot, 'PAYLOAD.json'), 'utf8'))
  assert.ok(payload.spawnedPrograms.includes(workerRelative), 'repack: PAYLOAD.json does not declare the vault worker')
  assert.ok(payload.helperPrograms.includes(helperRelative), 'repack: PAYLOAD.json does not declare the vault host helper')
  const client = await readFile(path.join(stagedRoot, 'src/lib/vault-host-client.js'), 'utf8')
  assert.match(client, /path\.join\(__dirname, 'vault-host', 'worker\.js'\)/,
    'the manifest must name the same computed worker path the staged client starts')
  const closure = computeClosure(stagedRoot, [workerRelative])
  assert.deepEqual(closure.unresolved, [], 'the staged worker has a missing JavaScript dependency')
  assert.deepEqual(closure.external, [], 'the staged worker cannot depend on an unstaged npm package')
  assert.deepEqual(closure.dynamic, [], 'the staged worker has an undeclared computed require')
  assert.ok(closure.files.includes('src/lib/runtime-state-root.js'), 'the worker must retain its real state/profile resolver')
  const powershell = computePowerShellClosure(stagedRoot, [helperRelative])
  assert.deepEqual(powershell.unresolved, [], 'the staged vault host has a missing PowerShell dependency')
  for (const dependency of [helperRelative, 'tools/secrets.ps1', 'tools/lib/vault-acl.ps1']) {
    assert.ok(powershell.files.includes(dependency), `${dependency} is missing from the real host closure`)
  }

  const scratch = await temporaryTree(t)
  const worker = new Worker(path.join(stagedRoot, workerRelative), { env: {
    TOOLSENABLED_STATE_ROOT: path.join(scratch, 'state'),
    TOOLSENABLED_VAULT_PATH: path.join(scratch, 'unused-vault.json'),
  } })
  const { port1, port2 } = new MessageChannel()
  let deadline
  try {
    const received = new Promise((resolve, reject) => {
      worker.once('error', reject)
      worker.once('exit', code => reject(new Error(`vault worker exited before answering: ${code}`)))
      port1.once('message', resolve)
      deadline = setTimeout(() => reject(new Error('the staged vault worker did not answer its bounded inert probe')), 10_000)
    })
    const signal = new Int32Array(new SharedArrayBuffer(4))
    // This unsupported action returns BEFORE startHost(). No PowerShell
    // process, provider, secret read or write is invoked by this proof.
    worker.postMessage({ sab: signal, port: port2, payload: { action: '__packaging_probe_forbidden' }, env: {} }, [port2])
    assert.deepEqual(await received, { unavailable: true }, 'the real worker must refuse an unsupported action')
    await Atomics.waitAsync(signal, 0, 0, 1_000).value
    assert.equal(Atomics.load(signal, 0), 1, 'the worker did not notify its synchronous caller')
  } finally {
    clearTimeout(deadline)
    port1.close()
    await worker.terminate()
  }
})
