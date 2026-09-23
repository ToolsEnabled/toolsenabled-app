#!/usr/bin/env node

import path from 'node:path'
import { pathToFileURL } from 'node:url'

const HELP = `Usage: node tools/release-packager/plan-readiness.mjs [--product <product>]

Print a JSON description of the fixed source qualification contract.
The default product is toolsenabled. This is planning-only: it performs no
qualification and does not read an installer, build, stage or create a receipt.
  --target <win32-x64|linux-x64>           Native target (default: win32-x64)

Optionally inspect the current source inventory and required entry points:
  --source-app <absolute directory>       ToolsEnabled app source
  --source-engine <absolute directory>    ToolsEnabled engine source
  --source-website <absolute directory>   Source for a standalone product

Supply both app and engine roots for ToolsEnabled, or only website for a
standalone product. Inspection uses the qualifier's fixed inventory; it never
executes the inspected code, changes the inventory, or accepts missing tests.
The target printed is the registered contract target, even on another host.
Source inspection does not verify Git refs, clean trees or native readiness.

Exit codes:
  0  Help, or a plan whose adapters are registered but still unverified.
  1  A planning-only report with required adapters missing, a registered adapter
     that has no executable scenario yet, or source obligations.
  2  Invalid arguments, unknown product, or a contract inspection error.
`

function parseArgs(argv) {
  let product = 'toolsenabled', suppliedProduct = false, help = false, target
  const sourceRoots = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') help = true
    else if (arg === '--product') {
      if (suppliedProduct) throw new Error('--product accepts exactly one value')
      const value = argv[++index]
      if (typeof value !== 'string' || !value.trim() || value.startsWith('-')) throw new Error('--product requires one product name')
      suppliedProduct = true
      product = value
    } else if (arg === '--target') {
      if (target) throw new Error('--target accepts exactly one value')
      const value = argv[++index]
      if (!['win32-x64', 'linux-x64'].includes(value)) throw new Error('--target requires a registered native target: win32-x64 or linux-x64')
      const [platform, arch] = value.split('-')
      target = { platform, arch }
    } else if (['--source-app', '--source-engine', '--source-website'].includes(arg)) {
      const name = arg.slice('--source-'.length)
      if (Object.hasOwn(sourceRoots, name)) throw new Error(`${arg} accepts exactly one directory`)
      const value = argv[++index]
      if (typeof value !== 'string' || !value.trim() || value.startsWith('-') || !path.isAbsolute(value)) {
        throw new Error(`${arg} requires one absolute source directory`)
      }
      sourceRoots[name] = value
    } else throw new Error(`unrecognized argument: ${arg}`)
  }
  return { product, help, options: { ...(target ? { target } : {}), ...(Object.keys(sourceRoots).length ? { sourceRoots } : {}) } }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(HELP)
    return
  }
  // Contract imports measure their fixed source implementation closure. Keep
  // those reads inside the command's error boundary and out of --help.
  const { createReadinessPlan } = await import('./lib/readiness-plan.mjs')
  const plan = createReadinessPlan(args.product, args.options)
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
  process.exitCode = plan.status === 'blocked' ? 1 : 0
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    process.stderr.write(`Readiness planning failed: ${error.message}\n`)
    process.exitCode = 2
  })
}
