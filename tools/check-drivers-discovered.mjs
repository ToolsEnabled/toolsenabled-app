#!/usr/bin/env node

// Discovery guard for the packaged QA drivers.
//
// WHAT IT IS FOR, MEASURED 2026-08-23. tools/packaged-qa-suite.mjs is what
// `npm run release:cut` runs before a publication. It discovered its membership
// with `/-qa\.(mjs|cjs)$/`, and twenty-eight harnesses in tools/ are named
// `*-drive.mjs`. They were not excluded with a reason, not reported, and not
// counted as skipped: they were never SEEN. 52 discovered, 28 invisible.
//
// Two of the twenty-eight -- provider-login-drive and provider-guide-drive --
// are the only drivers that exercise getting an assistant program and signing
// in to it, which is the first thing a customer does. No cut had ever checked
// it, and the owner found out the way customers do: a machine with Codex and
// Claude installed and signed in, told by the product that they were not
// installed and to go and install them.
//
// The pattern now reads both suffixes. That fixes today. This file is what
// makes it stay fixed, and it is the same rule
// tools/check-suites-discovered.mjs applies to the unit suites: a thing that
// exists and is never run is indistinguishable from a thing that passes.
//
// THE RULE
//
//   Every file under tools/ that LOOKS LIKE A DRIVER must be either
//     (a) discovered by the suite's own DRIVER_PATTERN, or
//     (b) a PowerShell harness delegated to by exact tools-relative path from a driver
//         that (a) discovers, or
//     (c) named by exact tools-relative path in a hold-out map with a reason.
//   Anything else fails this guard, by name.
//
// "LOOKS LIKE A DRIVER" IS ASKED TWO WAYS, AND BOTH ARE NEEDED.
//
//   BY NAME. The suffixes this repository gives its JavaScript harnesses: -qa,
//   -drive, -smoke, -e2e, plus the spellings a future author would plausibly
//   reach for (-driver, -drives, -walkthrough). Every PowerShell script in the
//   walked scope is also driver-shaped: DRIVER_PATTERN cannot discover that
//   language, so filtering `.ps1` first would be a false green.
//
//   BY CONTENT. A file that imports tools/test-account-harness.mjs is staging
//   the packaged build, opening its window and asserting profile isolation --
//   that import is what makes a file a driver of the packaged product, whatever
//   it happens to be called. This is the signal that catches a name nobody
//   anticipated, which is the only kind that will actually happen next.
//
//   Comments are stripped before the content question is asked. Four files in
//   tools/ mention the harness in prose (this suite's own header among them),
//   and an instrument that cannot tell code from prose manufactures false reds
//   until somebody switches it off.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not require a discovered driver to
// have a SETTINGS entry. The suite's own rule 2 is that an unregistered driver
// still RUNS, on defaults, and is reported as unregistered -- it is never
// dropped -- so an unregistered driver is visible, noisy and measured. Failing
// on it here would turn "add a driver" into "edit two files" for no gain in
// coverage, and there are twenty-four pre-existing unregistered `-qa` drivers
// whose classification is a separate piece of work with a separate argument.
//
// It also does not try to read a driver's prose for whether it spends money.
// That was measured before it was rejected: a regex over the repo's own
// "SPENDS REAL MONEY" convention reads "SPENDS NO PROVIDER BUDGET" as a spend
// in two files and misses that a third's spend is behind an opt-in flag. A gate
// that cries wolf on three of eighty on its first day gets switched off.
//
// USAGE
//   node tools/check-drivers-discovered.mjs
//   node tools/check-drivers-discovered.mjs --quiet   only the failures
//
// Exit 0 every driver-shaped file is accounted for · 1 one is not · 2 the guard
// could not run.

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { DRIVER_PATTERN, HELD_OUT_OF_DISCOVERY, HELD_OUT_POWERSHELL, discoverDrivers, staleHoldOuts, staleSettings } from './packaged-qa-suite.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TOOLS = path.join(REPO_ROOT, 'tools')
const QUIET = process.argv.includes('--quiet')

/* The name family, deliberately wider than DRIVER_PATTERN. If it were the same
   expression this guard would be a restatement of the thing under test and
   could never fail -- which is the shape of every gate in this repository that
   turned out to be measuring nothing. */
export const DRIVER_SHAPED_NAME = /-(qa|drive|driver|drives|smoke|e2e|walkthrough)\.(mjs|cjs)$/

/* PowerShell cannot be a direct member of the JavaScript-only suite. It is
   accounted for only when a discovered driver names its exact tools-relative
   path in executable code, or when that path is held out with a written reason.
   For a root-level script the relative path is simply its basename. */
export const POWERSHELL_SCRIPT_NAME = /\.ps1$/i

/* The import, not the mention. `await import(...)` counts: signin-reach-probe
   reaches the harness that way and is a driver by every other measure. */
export const IMPORTS_HARNESS = /(?:from|import|require)\s*\(?\s*['"]\.\/test-account-harness\.mjs['"]/

/* Directories that hold no drivers by construction. tools/test/ is the unit
   suites' home and is guarded by tools/check-suites-discovered.mjs; its
   fixtures are stand-in engines, not harnesses. */
const SKIP_DIRECTORIES = new Set(['node_modules', 'test', 'brand', 'release-packager'])

/* Strip comments before the content question. Same helper, same reason, as
   tools/test/packaged-qa-suite.test.mjs: a rule read out of a paragraph that
   explains why the code no longer does something is a false red. */
export function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map(line => line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'))
    .join('\n')
}

export function looksLikeADriver(name, source) {
  if (POWERSHELL_SCRIPT_NAME.test(name)) {
    return 'it is a PowerShell script under tools/, outside the suite\'s JavaScript-only DRIVER_PATTERN'
  }
  if (DRIVER_SHAPED_NAME.test(name)) return 'its name ends in a driver suffix'
  if (typeof source === 'string' && IMPORTS_HARNESS.test(codeOnly(source))) {
    return 'it imports tools/test-account-harness.mjs, which stages the packaged build and opens its window'
  }
  return null
}

function everyScript(directory, found = []) {
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch (error) {
    throw new Error(`cannot read ${directory} (${error.code ?? error.message})`)
  }
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue
      everyScript(absolute, found)
    } else if (entry.isFile() && /\.(mjs|cjs|ps1)$/i.test(entry.name) && !entry.name.endsWith('.test.mjs')) {
      found.push(absolute)
    }
  }
  return found
}

function relative(absolute) {
  return path.relative(REPO_ROOT, absolute).split(path.sep).join('/')
}

/* The whole finding, as data, so the test suite can exercise the decision
   instead of parsing this file's console output. */
export function auditDrivers(toolsDirectory = TOOLS) {
  toolsDirectory = path.resolve(toolsDirectory)
  const discovered = new Set(discoverDrivers(toolsDirectory))
  const discoveredSources = new Map()
  for (const name of discovered) {
    try {
      discoveredSources.set(name, codeOnly(readFileSync(path.join(toolsDirectory, name), 'utf8')))
    } catch {
      /* An unreadable wrapper proves no delegation. */
    }
  }
  const shaped = []
  const unseen = []

  for (const file of everyScript(toolsDirectory)) {
    const name = path.basename(file)
    const key = path.relative(toolsDirectory, file).split(path.sep).join('/')
    let source = ''
    try { source = readFileSync(file, 'utf8') } catch { /* unreadable is still judged on its name */ }
    const why = looksLikeADriver(name, source)
    if (!why) continue
    /* Discovery reads one directory. Delegation and hold-outs name exact
       tools-relative paths so a root-level declaration cannot hide a nested
       driver (or a different nested helper with the same basename). */
    const isDiscovered = discovered.has(name) && path.dirname(file) === path.resolve(toolsDirectory)
    const exactName = new RegExp(`(['"])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1`)
    const delegatedBy = POWERSHELL_SCRIPT_NAME.test(name)
      ? [...discoveredSources]
        .filter(([, discoveredSource]) => exactName.test(discoveredSource))
        .map(([driverName]) => driverName)
        .sort()
      : []
    /* A PowerShell helper that no driver delegates to may be held out in
       writing under its tools-relative path (HELD_OUT_POWERSHELL); the
       staleness check below resolves the same key, so they cannot disagree. */
    const isHeldOut = HELD_OUT_OF_DISCOVERY.has(key) || (POWERSHELL_SCRIPT_NAME.test(name) && HELD_OUT_POWERSHELL.has(key))
    shaped.push({ file: relative(file), key, name, why, discovered: isDiscovered, delegatedBy, heldOut: isHeldOut })
    if (!isDiscovered && delegatedBy.length === 0 && !isHeldOut) unseen.push({ file: relative(file), key, name, why })
  }

  /* A hold-out that the pattern DOES reach is a contradiction: the suite would
     run it while this map says it is deliberately out of reach. Whichever is
     wrong, a reader cannot tell which, and that is the state this whole guard
     exists to make impossible. */
  const reachableNames = new Set(
    shaped.filter(entry => entry.discovered || entry.delegatedBy.length > 0).map(entry => entry.key),
  )
  const contradictions = [...HELD_OUT_OF_DISCOVERY.keys()].filter(name => reachableNames.has(name))

  return {
    discovered: [...discovered].sort(),
    shaped,
    unseen,
    contradictions,
    staleSettings: staleSettings([...discovered]),
    staleHoldOuts: [
      ...staleHoldOuts(toolsDirectory),
      ...[...HELD_OUT_POWERSHELL.keys()].filter(key => !existsSync(path.join(toolsDirectory, key))),
    ],
  }
}

function main() {
  const audit = auditDrivers()

  if (audit.discovered.length === 0) {
    console.error('Driver discovery guard: the suite\'s DRIVER_PATTERN matches ZERO files under tools/.')
    console.error(`  ${DRIVER_PATTERN} found nothing. A gate that discovered nothing reports success; this one does not.`)
    process.exitCode = 1
    return
  }

  if (!QUIET) {
    console.log(
      `Driver discovery: ${audit.discovered.length} driver(s) reached by ${DRIVER_PATTERN}; ` +
      `${audit.shaped.length} driver-shaped file(s) exist under tools/; ` +
      `${HELD_OUT_OF_DISCOVERY.size} JavaScript and ${HELD_OUT_POWERSHELL.size} PowerShell files held out with a written reason.`,
    )
  }

  let failed = false

  if (audit.unseen.length > 0) {
    failed = true
    console.error(
      `\n${audit.unseen.length} file(s) look like a QA driver and are NEITHER discovered, ` +
      'delegated to by a discovered driver, NOR held out:',
    )
    for (const entry of audit.unseen) console.error(`  ${entry.file}  -- ${entry.why}`)
    console.error(
      `\nEach one is invisible to tools/packaged-qa-suite.mjs, which is what release:cut runs before a\n` +
      'publication. Do ONE of these, and neither of them quietly:\n' +
      `  - rename it so ${DRIVER_PATTERN} reaches it, and give it a SETTINGS entry; or\n` +
      '  - for a PowerShell harness, add a discovered JavaScript driver that invokes it and names its exact tools-relative path; or\n' +
      '  - widen DRIVER_PATTERN, if a new naming family is genuinely wanted; or\n' +
      '  - add its exact tools-relative path to a hold-out map with a reason naming its separate scope.\n' +
      'A driver that exists and is never run is indistinguishable from one that passes.',
    )
  }

  if (audit.contradictions.length > 0) {
    failed = true
    console.error(`\n${audit.contradictions.length} file(s) are held out of discovery AND discovered by the pattern:`)
    for (const name of audit.contradictions) console.error(`  ${name}`)
    console.error('  The suite would run these while the map says they are out of reach. Remove one of the two claims.')
  }

  if (audit.staleSettings.length > 0) {
    failed = true
    console.error(`\n${audit.staleSettings.length} SETTINGS entr(ies) name a driver that is not on disk:`)
    for (const name of audit.staleSettings) console.error(`  ${name}`)
  }

  if (audit.staleHoldOuts.length > 0) {
    failed = true
    console.error(`\n${audit.staleHoldOuts.length} HELD_OUT_OF_DISCOVERY entr(ies) name a file that is not on disk:`)
    for (const name of audit.staleHoldOuts) console.error(`  ${name}`)
    console.error('  A hold-out for a file nobody can find is a reason nobody can act on.')
  }

  if (failed) {
    process.exitCode = 1
    return
  }

  if (!QUIET) {
    console.log('Every driver-shaped file under tools/ is discovered, delegated to by a discovered driver, or held out in writing.')
  }
}

/* argv can name this file through a symlink, junction, or differently-cased
   path. Compare filesystem identities: a lexical comparison silently skips
   main in those real release lanes and turns every finding into exit 0. */
const invokedFile = process.argv[1]
let isMainModule = false
if (invokedFile) {
  try {
    isMainModule = realpathSync.native(invokedFile) === realpathSync.native(fileURLToPath(import.meta.url))
  } catch { /* an argv path that cannot be resolved is not this module */ }
}

if (isMainModule) {
  try {
    main()
  } catch (error) {
    console.error(`Driver discovery guard error: ${error?.message ?? error}`)
    process.exitCode = 2
  }
}
