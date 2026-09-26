#!/usr/bin/env node

// DRIVE THE PERMISSION FENCE. DO NOT READ ITS TABLE.
//
// The fence (capability/src/lib/confined-tool-surface.js +
// permission-tier-policy.js) is a security boundary that did not exist this
// morning. A new boundary verified only by its own unit tests is exactly the
// pattern that shipped the last fifteen defects here, so this file never reads
// the classification table and never asserts a count. It takes the REAL tool
// entries out of the SHIPPED payload's registry, builds the REAL sessions the
// recorded installation levels produce, and calls the REAL chokepoint functions
// that src/lib/tool-registry.js calls on every dispatch (executeTool ->
// assertToolAllowed, then assertConfinedArgumentsAllowed). Every escape below
// is one that was demonstrated end-to-end through an admitted, ungated tool
// before this fence existed.
//
// IT MEASURES THE PAYLOAD THAT SHIPS, not the engine working tree. `--payload`
// points it at any staged or packed capability directory; the default is this
// repo's staged `capability/`. A fix can grep as present in the engine source
// and be absent from what a customer installs, and that has already happened
// here more than once this week.
//
// ABSENCE IS TESTED FIRST AND AS ITS OWN CASE, three ways, because
// absence-read-as-consent is this codebase's recurring defect and has been
// found nine times including inside a fence:
//   A1  a tool no table names        -> must be REFUSED, not admitted
//   A2  no workspace roots at all    -> must be REFUSED, not "unbounded"
//   A3  an empty roots array         -> must be REFUSED, not "nothing to check"
//
// AND IT PROVES THE FENCE IS NOT SIMPLY "NO" TO EVERYTHING. A fence that
// refuses a legitimate in-workspace path is not a fence, it is an outage, and a
// suite with no admit case cannot tell the two apart.
//
// Exit 0 = every case behaved. Exit 1 = at least one did not. Exit 2 = the
// probe could not run, which is never reported as a pass.

import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require_ = createRequire(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const results = []
function check(group, name, pass, detail = '') {
  results.push({ group, name, pass })
  console.log(`${pass ? '  ok  ' : '  FAIL'} [${group}] ${name}${detail ? `  --  ${detail}` : ''}`)
}

/* A refusal is only evidence if it is the RIGHT refusal. A tool that threw
   because a path was unparseable, or because some unrelated guard fired, would
   look identical to a fence decision from the outside -- and on this project a
   deliberate refusal reported as an unreadable input is a named, fixed defect.
   So every expectation below names the codes that count. */
function expectRefusal(group, name, codes, run, detail = '') {
  let error = null
  try { run() } catch (thrown) { error = thrown }
  if (error === null) {
    check(group, name, false, `ADMITTED${detail ? ` (${detail})` : ''} -- this is an escape`)
    return
  }
  const code = error.code || '(no code)'
  check(group, name, codes.includes(code), `refused ${code}${detail ? ` (${detail})` : ''}`)
}

function expectAdmitted(group, name, run, detail = '') {
  try {
    run()
    check(group, name, true, detail)
  } catch (error) {
    check(group, name, false, `REFUSED ${error.code || error.message} -- the fence is an outage here`)
  }
}

function requirePayloadFile(label, file) {
  try {
    statSync(file)
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      console.error(`fence probe cannot run [FENCE_PROBE_PAYLOAD_ABSENT]: ${label} is not in the payload at ${file}`)
      process.exitCode = 2
      return false
    }
    const causeCode = error && typeof error.code === 'string' ? error.code : 'NO_ERROR_CODE'
    const failure = new Error(
      `could not inspect ${label} at ${file} (${causeCode}). ` +
      'This does NOT claim that the payload file is absent.',
      { cause: error },
    )
    failure.code = 'FENCE_PROBE_PAYLOAD_UNREADABLE'
    throw failure
  }
  return true
}

function main() {
  const payload = path.resolve(arg('payload', path.join(REPO_ROOT, 'capability')))
  const policyPath = path.join(payload, 'src', 'lib', 'permission-tier-policy.js')
  const registryPath = path.join(payload, 'src', 'lib', 'tool-registry.js')
  for (const [label, file] of [['permission-tier-policy', policyPath], ['tool-registry', registryPath]]) {
    if (!requirePayloadFile(label, file)) return
  }
  console.log(`payload under test: ${payload}\n`)

  const policy = require_(policyPath)
  const registry = require_(registryPath)
  const entries = registry.registeredTools ? registry.registeredTools() : null
  if (!Array.isArray(entries) || entries.length === 0) {
    console.error('fence probe cannot run: the shipped registry produced no tool entries.')
    process.exitCode = 2
    return
  }
  const byName = new Map(entries.map(entry => [entry.name, entry]))
  const standard = policy.installTierSession('standard')
  const guided = policy.installTierSession('guided')

  // A real workspace root on this disk, and a sibling that shares its prefix.
  const scratch = path.join(os.tmpdir(), `fence-probe-${process.pid}`)
  const workspace = path.join(scratch, 'ws')
  const sibling = path.join(scratch, 'ws-evil')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(sibling, { recursive: true })
  writeFileSync(path.join(workspace, 'inside.txt'), 'inside\n')
  writeFileSync(path.join(sibling, 'outside.txt'), 'outside\n')
  const roots = [workspace]

  const allow = (name, args) => {
    const entry = byName.get(name)
    if (!entry) throw Object.assign(new Error(`the payload does not register '${name}'`), { code: 'TOOL_ABSENT' })
    policy.assertToolAllowed(entry, standard)
    policy.assertConfinedArgumentsAllowed(entry, standard, args, roots)
  }

  // ---------------------------------------------------------------- absence
  console.log('[absence] the failure shape this codebase keeps repeating')

  expectRefusal('absence', 'A1 a tool no table classifies is refused, not admitted by silence',
    ['PERMISSION_CONFINED_UNCLASSIFIED_REFUSED'],
    () => policy.assertToolAllowed({ name: 'fence.probe.unclassified', effect: 'local-read' }, standard))

  expectRefusal('absence', 'A2 no workspace roots at all refuses, rather than fencing nothing',
    ['PERMISSION_CONFINED_WORKSPACE_REFUSED', 'PERMISSION_CONFINED_PATH_UNREADABLE'],
    () => policy.assertConfinedArgumentsAllowed(byName.get('search.index'), standard,
      { root: path.join(workspace, 'sub') }, null))

  expectRefusal('absence', 'A3 an EMPTY roots array refuses, rather than reading "nothing to check"',
    ['PERMISSION_CONFINED_WORKSPACE_REFUSED', 'PERMISSION_CONFINED_PATH_UNREADABLE'],
    () => policy.assertConfinedArgumentsAllowed(byName.get('search.index'), standard,
      { root: path.join(workspace, 'sub') }, []))

  // ----------------------------------------------------------------- admit
  console.log('\n[admit] the fence must still let the granted folder work')

  expectAdmitted('admit', 'a path INSIDE the recorded root is admitted',
    () => allow('search.index', { root: path.join(workspace, 'sub', 'deeper') }),
    path.join(workspace, 'sub', 'deeper'))

  expectAdmitted('admit', 'the root itself is admitted',
    () => allow('search.index', { root: workspace }), workspace)

  expectAdmitted('admit', 'an omitted optional path is not treated as an escape',
    () => allow('launch.detect', {}))

  // ------------------------------------------------------- documented escapes
  console.log('\n[escape] the four routes that were open before this fence existed')

  expectRefusal('escape', 'extension.package cannot write into %TEMP%',
    ['PERMISSION_CONFINED_WORKSPACE_REFUSED'],
    () => allow('extension.package', { cwd: workspace, outputPath: path.join(os.tmpdir(), 'FENCE-ESCAPE', 'escaped.zip') }),
    path.join(os.tmpdir(), 'FENCE-ESCAPE', 'escaped.zip'))

  expectRefusal('escape', 'extension.package cannot climb out with ..',
    ['PERMISSION_CONFINED_WORKSPACE_REFUSED'],
    () => allow('extension.package', { cwd: workspace, outputPath: path.join(workspace, '..', '..', 'x.zip') }),
    `${workspace}\\..\\..\\x.zip`)

  expectRefusal('escape', 'extension.package cannot climb out through the HOME directory',
    ['PERMISSION_CONFINED_WORKSPACE_REFUSED'],
    () => allow('extension.package', { cwd: workspace, outputPath: path.join(os.homedir(), 'fence-escape.zip') }),
    path.join(os.homedir(), 'fence-escape.zip'))

  expectRefusal('escape', 'search.index cannot read outside the workspace root',
    ['PERMISSION_CONFINED_WORKSPACE_REFUSED'],
    () => allow('search.index', { root: sibling }), sibling)

  expectRefusal('escape', 'launch.detect cannot enumerate outside the workspace root',
    ['PERMISSION_CONFINED_WORKSPACE_REFUSED'],
    () => allow('launch.detect', { cwd: sibling }), sibling)

  // The code.* route is the one no PATH fence can bound: a language server is
  // started against a caller-supplied root and then answers about whatever it
  // can reach. The right answer is not a better path check, it is refusing the
  // tool at this level, so that is what is asserted.
  for (const name of ['code.diagnostics', 'code.document_symbols', 'code.find_references', 'code.goto_definition']) {
    if (!byName.has(name)) continue
    expectRefusal('escape', `${name} is refused as unconfinable, not path-checked`,
      ['PERMISSION_CONFINED_UNCONFINABLE_REFUSED', 'PERMISSION_CONFINED_EXCLUSION_REFUSED'],
      () => policy.assertToolAllowed(byName.get(name), standard))
  }

  // ------------------------------------------------------ windows path shapes
  console.log('\n[windows] the shapes that make a naive prefix check wrong on this OS')

  const shapes = [
    ['a UNC path', '\\\\127.0.0.1\\C$\\Windows\\Temp\\escaped.zip'],
    ['a \\\\?\\ device path', `\\\\?\\${sibling}\\escaped.zip`],
    ['a \\\\?\\UNC\\ device path', '\\\\?\\UNC\\127.0.0.1\\C$\\escaped.zip'],
    ['an alternate data stream on an inside file', `${path.join(workspace, 'inside.txt')}:hidden`],
    ['an alternate data stream on the root itself', `${workspace}:hidden:$DATA`],
    ['a raw device namespace path', '\\\\.\\PhysicalDrive0'],
    ['an 8.3-style short name', path.join(path.dirname(sibling), 'WS-EVI~1', 'escaped.zip')],
  ]
  for (const [label, value] of shapes) {
    expectRefusal('windows', `${label} is refused`,
      ['PERMISSION_CONFINED_WORKSPACE_REFUSED', 'PERMISSION_CONFINED_PATH_UNREADABLE'],
      () => allow('extension.package', { cwd: workspace, outputPath: value }), value)
  }

  /* SEGMENT-WISE CONTAINMENT. `C:\ws-evil` starts with the string `C:\ws`, so a
     fence written as startsWith() admits it. This is the single most common way
     a path fence is wrong, and it is worth its own case rather than being one
     of a list. */
  expectRefusal('windows', 'a sibling directory sharing the root\'s NAME PREFIX is refused',
    ['PERMISSION_CONFINED_WORKSPACE_REFUSED'],
    () => allow('search.index', { root: sibling }), `${sibling} vs root ${workspace}`)

  // ------------------------------------------------------------ tier ordering
  console.log('\n[tiers] Guided must be a strict subset of Standard, not a different shape')

  const admitted = tierSession => entries.filter(entry => {
    try { policy.assertToolAllowed(entry, tierSession); return true } catch { return false }
  }).map(entry => entry.name)
  const standardNames = new Set(admitted(standard))
  const guidedNames = admitted(guided)
  const leak = guidedNames.filter(name => !standardNames.has(name))
  check('tiers', 'no tool is admitted at Guided that Standard refuses',
    leak.length === 0, leak.length === 0
      ? `guided=${guidedNames.length} standard=${standardNames.size} of ${entries.length} registered`
      : `LEAKED: ${leak.join(', ')}`)
  check('tiers', 'Standard does not admit the whole registry',
    standardNames.size < entries.length,
    `standard admits ${standardNames.size} of ${entries.length}`)

  try { rmSync(scratch, { recursive: true, force: true }) } catch { /* the OS reclaims a temp dir */ }

  const failed = results.filter(result => !result.pass)
  console.log(`\n${results.length - failed.length}/${results.length} fence cases behaved`)
  if (failed.length > 0) {
    console.error(`\n${failed.length} FENCE CASE(S) FAILED:`)
    for (const result of failed) console.error(`  [${result.group}] ${result.name}`)
    process.exitCode = 1
  }
}

try {
  main()
} catch (error) {
  const code = error && typeof error.code === 'string' ? error.code : 'FENCE_PROBE_UNKNOWN_FAILURE'
  const detail = error && (error.stack || error.message) ? error.stack || error.message : String(error)
  console.error(`fence probe could not run [${code}]: ${detail}`)
  process.exitCode = 2
}
