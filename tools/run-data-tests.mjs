#!/usr/bin/env node

// Cross-platform test:data selector. The package contract keeps the wildcard
// visible to discovery, but this runner expands it itself so the unchanged
// 109-case T542 source is executed only through its two bounded wrappers.
import { readdirSync } from 'node:fs'
import { once } from 'node:events'
import { run } from 'node:test'
import { tap } from 'node:test/reporters'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const testDirectory = path.join(root, 'tools', 'test')
const wildcard = 'tools/test/*.test.mjs'
const original = 't542-pending-model-choice.test.mjs'
const wrappers = ['t542-pending-model-choice-a.test.mjs', 't542-pending-model-choice-b.test.mjs']
const args = process.argv.slice(2)
const printSelection = args.includes('--print-selection')
if (printSelection) args.splice(args.indexOf('--print-selection'), 1)
const explicitSuites = args.filter(arg => arg !== wildcard && /^tools\/test\/[^/]+\.test\.mjs$/.test(arg))
const wildcardCount = args.filter(arg => arg === wildcard).length
const retainedOptions = [
  '--import=./tools/test/lib/isolate-native-state-root.mjs',
  '--test-reporter=tap',
  '--test-concurrency=1',
]

if (wildcardCount > 1 || (wildcardCount === 0 && explicitSuites.length === 0)) {
  console.error(`test:data selector requires exactly one ${wildcard} argument`)
  process.exit(2)
}

const selected = readdirSync(testDirectory, { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith('.test.mjs') && entry.name !== original)
  .map(entry => `tools/test/${entry.name}`)
  .sort()
const missingWrappers = wrappers.filter(file => !selected.includes(`tools/test/${file}`))
if (missingWrappers.length) {
  console.error(`test:data selector missing required T542 wrapper(s): ${missingWrappers.join(', ')}`)
  process.exit(2)
}

// POSIX shells expand an unquoted package wildcard before this script starts;
// Windows command shells pass the literal wildcard. Accept both forms, but
// never accept a path outside the fixed top-level test directory.
const allowedSuites = new Set([...selected, `tools/test/${original}`])
const unknownSuites = explicitSuites.filter(file => !allowedSuites.has(file))
const unknownArguments = args.filter(arg => arg !== wildcard
  && !explicitSuites.includes(arg) && !retainedOptions.includes(arg))
if (unknownSuites.length || unknownArguments.length) {
  const details = [...unknownSuites.map(file => `unknown suite ${file}`),
    ...unknownArguments.map(arg => `unsupported argument ${arg}`)]
  console.error(`test:data selector refused: ${details.join(', ')}`)
  process.exit(2)
}
const optionCounts = new Map(retainedOptions.map(option => [option, args.filter(arg => arg === option).length]))
if ([...optionCounts].some(([, count]) => count > 1)) {
  console.error('test:data selector refused: duplicate retained runner option')
  process.exit(2)
}
const sourcePlan = {
  original: { file: `tools/test/${original}`, directJobs: 0, retainedInDiscovery: true,
    importedBy: wrappers.map(file => `tools/test/${file}`) },
  wrappers: wrappers.map(file => ({ file: `tools/test/${file}`, directJobs: 1,
    imports: [`tools/test/${original}`] })),
  allBehaviorsImported: true,
}
process.stderr.write(`test:data selector: ${selected.length} direct suite(s), original source retained/imported with 0 direct jobs, wrappers ${wrappers.join(' + ')}\n`)

async function writeStdout(chunk) {
  await new Promise((resolve, reject) => {
    process.stdout.write(chunk, error => error ? reject(error) : resolve())
  })
}

if (printSelection) {
  await writeStdout(JSON.stringify({ sourcePlan, wrappers, selected }, null, 2) + '\n')
  process.exitCode = 0
}

// Keep the selected files in JavaScript memory instead of serializing them into
// one CreateProcess argv. The package wildcard is longer than Windows' command
// line limit once the 1,645 concrete paths are expanded. Node 22's programmatic
// runner still starts one isolated child per file, accepts the same preload and
// concurrency settings, and the built-in TAP reporter preserves the package
// transcript shape.
async function writeTap(source) {
  for await (const chunk of tap(source)) {
    if (!process.stdout.write(chunk)) await once(process.stdout, 'drain')
  }
}

async function runSelected() {
  let failed = false
  const events = run({
    files: selected.map(file => path.resolve(root, file)),
    concurrency: 1,
    isolation: 'process',
    execArgv: [retainedOptions.find(option => option.startsWith('--import='))],
  })
  async function* observed() {
    for await (const event of events) {
      if (event.type === 'test:fail') failed = true
      yield event
    }
  }
  await writeTap(observed())
  process.exitCode = failed ? 1 : 0
}

if (!printSelection) {
  runSelected().catch(error => {
    console.error(`test:data child failed to start: ${error?.message || error}`)
    process.exitCode = 1
  })
}
