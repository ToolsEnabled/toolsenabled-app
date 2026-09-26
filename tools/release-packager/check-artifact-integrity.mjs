#!/usr/bin/env node

import path from 'node:path'
import { pathToFileURL } from 'node:url'

const HELP = `Usage: node tools/release-packager/check-artifact-integrity.mjs
  --target <win32-x64|linux-x64> --artifact <absolute installer file>
  --context <absolute private context JSON> [--product <product>]
  --app-ref <40 hex commit> --engine-ref <40 hex commit>

Check exact packaged artifact integrity using the fixed native decoder and
source/payload/privacy/license checks, then independently replay those checks.
ToolsEnabled is the default product. Windows standalone products use only
--website-ref <40 hex commit>. Linux currently supports ToolsEnabled only.

The existing qualification context must name sourceRoots, stageRoot,
harnessRoot and a separate private evidenceRoot. The context JSON must be
inside evidenceRoot. Use clean exact source snapshots and the matching stage;
this command accepts no tool, adapter, policy, receipt or timeout overrides.

This is ARTIFACT-ONLY. It does not execute installers, source suites or product
journeys. Success prints a distinct artifact-integrity-check JSON report with
releaseReady:false and every remaining requirement. It is not a full release
readiness receipt and cannot authorize tagging, promotion or publication.

Exit codes: 0 help or artifact-only success; 1 failed artifact check;
2 invalid arguments. Raw execution evidence stays in the private evidenceRoot.
`

export function parseArtifactCheckArgs(argv) {
  if (!Array.isArray(argv)) throw new Error('arguments must be an array')
  const names = new Set(['product', 'target', 'artifact', 'context', 'app-ref', 'engine-ref', 'website-ref'])
  const values = {}
  let help = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') { help = true; continue }
    const name = typeof arg === 'string' && arg.startsWith('--') ? arg.slice(2) : ''
    if (!names.has(name)) throw new Error(`unrecognized argument: ${arg}`)
    if (Object.hasOwn(values, name)) throw new Error(`${arg} accepts exactly one value`)
    const value = argv[++index]
    if (typeof value !== 'string' || !value.trim() || value.startsWith('-')) throw new Error(`${arg} requires one value`)
    values[name] = value
  }
  if (help) return { help: true }
  const product = values.product || 'toolsenabled'
  if (!['toolsenabled', 'scribe', 'web-editor', 'presentation-suite'].includes(product)) throw new Error('unknown product')
  if (!['win32-x64', 'linux-x64'].includes(values.target)) throw new Error('--target requires win32-x64 or linux-x64')
  if (values.target === 'linux-x64' && product !== 'toolsenabled') throw new Error('Linux artifact checking currently supports ToolsEnabled only')
  for (const name of ['artifact', 'context']) if (!values[name] || !path.isAbsolute(values[name])) throw new Error(`--${name} requires an absolute path`)
  const namesOfRefs = product === 'toolsenabled' ? ['app', 'engine'] : ['website']
  for (const name of ['app', 'engine', 'website']) {
    const value = values[`${name}-ref`]
    if (namesOfRefs.includes(name) ? !/^[a-f0-9]{40}$/i.test(value || '') : value !== undefined) throw new Error(`--${name}-ref must match the product's exact source selection`)
  }
  const [platform, arch] = values.target.split('-')
  return { help: false, product, target: { platform, arch }, artifactPath: values.artifact,
    contextPath: values.context, sourceRefs: Object.fromEntries(namesOfRefs.map(name => [name, values[`${name}-ref`].toLowerCase()])) }
}

async function main() {
  let args
  try { args = parseArtifactCheckArgs(process.argv.slice(2)) }
  catch (error) { process.stderr.write(`Artifact check arguments: ${error.message}\n`); process.exitCode = 2; return }
  if (args.help) { process.stdout.write(HELP); return }
  // No implementation hashing or filesystem inputs during --help/arg checks.
  const { checkArtifactIntegrity, readQualificationContext } = await import('../lib/release-readiness.mjs')
  const { help, contextPath, ...input } = args
  const context = readQualificationContext(contextPath, input.product)
  const result = await checkArtifactIntegrity({ ...input, context })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { process.stderr.write(`Artifact integrity check failed: ${error.message}\n`); process.exitCode = 1 })
}
