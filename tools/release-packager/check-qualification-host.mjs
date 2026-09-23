#!/usr/bin/env node
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const HELP = `Usage: node tools/release-packager/check-qualification-host.mjs [options]

Report, in one place, everything the Windows qualification host still needs
before tools/release-packager/cut-release-candidate.mjs can produce a readiness
receipt. It starts no machine, installer, job or product, writes nothing, and
its output is never qualification evidence.

  --profile <windows-x64-standard|windows-x64-administrator>
  --evidence-root <absolute directory>    private evidence directory
  --harness-root <absolute directory>     qualification harness checkout
  --runner-config <absolute file>         the dedicated worker description
  --product <product>                     default toolsenabled

Every option is optional; an omitted one is reported as its own blocker so a
first run on a bare host still lists the whole job.

Exit 0: every registered row has an executable scenario and the disposable
        guest reports available.
Exit 1: the printed blockers apply. This is the ordinary result today.
Exit 2: invalid arguments, or the check could not be loaded.
`

const OPTIONS = ['--profile', '--evidence-root', '--harness-root', '--runner-config', '--product']

function parseArgs(argv) {
  const result = { product: 'toolsenabled' }, seen = new Set()
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') { result.help = true; continue }
    if (!OPTIONS.includes(arg)) throw new Error(`unrecognized argument: ${arg}`)
    if (seen.has(arg)) throw new Error(`${arg} accepts exactly one value`)
    const value = argv[++index]
    if (typeof value !== 'string' || !value.trim() || value.startsWith('-')) throw new Error(`${arg} requires one value`)
    if (['--evidence-root', '--harness-root', '--runner-config'].includes(arg) && !path.isAbsolute(value)) {
      throw new Error(`${arg} requires one absolute path`)
    }
    seen.add(arg)
    result[{ '--profile': 'profile', '--evidence-root': 'evidenceRoot', '--harness-root': 'harnessRoot',
      '--runner-config': 'runnerConfigPath', '--product': 'product' }[arg]] = value
  }
  return result
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) { process.stdout.write(HELP); return }
  // Both imports measure their fixed source closure; keep those reads inside
  // the command's error boundary and out of --help.
  const [{ probeDisposableGuest }, { installedLifecycleScenarioCensus }] = await Promise.all([
    import('../lib/guest/disposable-guest.mjs'), import('../lib/adapters/installed-lifecycle.mjs')])
  const guest = probeDisposableGuest(args)
  const requirements = installedLifecycleScenarioCensus()
  const unexecutable = requirements.filter(row => !row.executableScenario).map(row => row.id)
  const report = {
    schema: 'toolsenabled.qualification-host-check', schemaVersion: 1, scope: 'precondition-only',
    authority: 'Read-only description of what is still missing. Nothing was executed and no release may rely on this document as evidence.',
    product: args.product, requirements, unexecutableRequirements: unexecutable, guest,
    ready: guest.available && unexecutable.length === 0,
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exitCode = report.ready ? 0 : 1
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    process.stderr.write(`Qualification host check failed: ${error.message}\n`)
    process.exitCode = 2
  })
}
