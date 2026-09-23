#!/usr/bin/env node
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const HELP = `Usage: node tools/release-packager/check-lifecycle-inputs.mjs --inventory <absolute-file> [--product <product>] [--repository-root <primary-checkout>]

Validate committed lifecycle inputs using the fixed source schema and portable
local Git preparation checks. Product defaults to toolsenabled.
The input must be a complete repository or a linked worktree with reciprocal
Git metadata. A linked worktree requires --repository-root to name its primary
checkout explicitly; pointer bytes cannot authorize an external metadata path.
Partial clones, aliases and external object stores are refused.
Output is preparation-only JSON, never native inventory authority, measured
installer evidence or a release receipt. No guest or installer is started.

Exit 0: input preparation checks completed; native prerequisites remain.
Exit 1: the supplied input or its committed source could not be validated.
Exit 2: invalid arguments or the preparation command could not be loaded.
`

function parseArgs(argv) {
  const result = { product: 'toolsenabled' }, seen = new Set()
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') { result.help = true; continue }
    if (!['--inventory', '--product', '--repository-root'].includes(arg)) throw new Error(`unrecognized argument: ${arg}`)
    if (seen.has(arg)) throw new Error(`${arg} accepts exactly one value`)
    const value = argv[++index]
    if (typeof value !== 'string' || !value.trim() || value.startsWith('-')) throw new Error(`${arg} requires one value`)
    seen.add(arg)
    result[{ '--inventory': 'inventoryPath', '--product': 'product', '--repository-root': 'repositoryRoot' }[arg]] = value
  }
  if (!result.help && !result.inventoryPath) throw new Error('--inventory is required')
  return result
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) { process.stdout.write(HELP); return }
  const { checkLifecycleInputs } = await import('./lib/lifecycle-input-check.mjs')
  try {
    const report = checkLifecycleInputs({ inventoryPath: args.inventoryPath, product: args.product, ...(args.repositoryRoot ? { repositoryRoot: args.repositoryRoot } : {}) })
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`Lifecycle input preparation failed: ${error.message}\n`)
    process.exitCode = 1
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    process.stderr.write(`Lifecycle input preparation failed: ${error.message}\n`)
    process.exitCode = 2
  })
}
