// npm run doctor -- the first command to run in this checkout, and the one
// that would have saved a debugging cycle on 2026-08-14, when a Desktop
// reorganization left node_modules an empty real directory and moved the
// engine out of the sibling layout. Every check reports a sentence; every
// failure prints the command that fixes it. Exit code = number of failures.
import { existsSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { discoverCanonicalRoot, ENGINE_MARKER } from './canonical-root.mjs'
import { DEFAULT_STAGING_ROOT } from './release-packager/cut-release-candidate.mjs'

const here = fileURLToPath(import.meta.url)
const REPO = dirname(dirname(here))

const lines = []
let failures = 0
function ok(sentence) {
  lines.push(`  ok    ${sentence}`)
}
function warn(sentence) {
  lines.push(`  WARN  ${sentence}`)
}
function fail(sentence, fix) {
  lines.push(`  FAIL  ${sentence}`)
  if (fix) lines.push(`        fix: ${fix}`)
  failures += 1
}

// 1. node_modules is populated. An interrupted move or clone leaves an EMPTY
//    REAL DIRECTORY here, which fails every build, test and Electron launch
//    with errors that never name the actual cause.
const nodeModules = join(REPO, 'node_modules')
if (!existsSync(nodeModules)) {
  fail('node_modules does not exist; nothing can build or test.', 'npm ci')
} else {
  const entries = readdirSync(nodeModules).filter((name) => !name.startsWith('.'))
  if (entries.length === 0) {
    fail(
      'node_modules exists but is EMPTY -- the signature a relocation leaves behind. Every build, test and launch fails until it is restored.',
      'npm ci',
    )
  } else if (!existsSync(join(nodeModules, 'electron')) || !existsSync(join(nodeModules, 'vite'))) {
    fail(
      `node_modules has ${entries.length} entries but is missing electron or vite -- a partial install.`,
      'npm ci',
    )
  } else {
    ok(`node_modules is populated (${entries.length} entries, electron and vite present).`)
  }

  // 1b. EVERY DECLARED DEPENDENCY IS ACTUALLY THERE.
  //
  // The check above asks whether node_modules is EMPTY. That is not the shape
  // this checkout keeps failing in. Measured three times on 2026-08-27: the
  // directory held ~200 packages -- so it read as populated, electron and vite
  // both present -- while THIRTEEN declared dependencies were absent
  // (@rollup/rollup-win32-x64-msvc, echarts, app-builder-lib, builder-util,
  // builder-util-runtime, ajv, @carbon/colors, three @fontsource-variable
  // fonts, culori, d3-array, d3-force). The likely cause is an npm reify
  // interrupted partway -- npm removes before it adds, and this checkout's
  // electron is running as MCP servers, so an install fails EBUSY mid-flight
  // and leaves holes.
  //
  // WHAT IT COST EACH TIME: the build died at vite with MODULE_NOT_FOUND, the
  // license gate failed six dependencies it "cannot verify", and the ratchet
  // reported eleven REGRESSIONS blocking the ship path. All of it reads as
  // broken product code. None of it was. A partial tree must be named as a
  // partial tree, here, rather than diagnosed one failing suite at a time.
  let declared = {}
  try {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      Object.assign(declared, pkg[field] || {})
    }
  } catch (error) {
    // Unreadable is not empty: say so rather than reporting zero missing.
    declared = null
    fail(
      `package.json could not be read (${error.code || error.message}), so which dependencies SHOULD be `
      + 'present cannot be answered. This is not a report that they are all there.',
      'check the file is valid JSON',
    )
  }
  if (declared) {
    const absent = Object.keys(declared)
      .filter((name) => !existsSync(join(nodeModules, ...name.split('/'))))
      .sort()
    if (absent.length > 0) {
      fail(
      `node_modules is missing ${absent.length} DECLARED dependenc${absent.length === 1 ? 'y' : 'ies'}: `
      + `${absent.join(', ')}. The directory is populated, so every other check here passes and the `
      + 'failure surfaces later as MODULE_NOT_FOUND, an unverifiable license, or a ratchet regression '
      + '-- none of which name the real cause.',
      'npm ci  (or, while Electron is running from this node_modules, fetch the named packages into a '
      + 'scratch prefix and copy them in -- a reify relocates electron and fails EBUSY)',
    )
    } else {
      ok(`all ${Object.keys(declared).length} declared dependencies are present.`)
    }

    // 1c. THE COMMAND SHIMS EXIST, NOT JUST THE PACKAGES.
    //
    // Found 2026-08-27, one layer below the check above and after it had already
    // been hardened once: node_modules held 238 packages including vite, rollup
    // and electron-builder, every declared dependency was present, and
    // node_modules/.bin held ZERO entries. `npm run build` died with "'vite' is
    // not recognized", which reads as a missing dependency and is not one -- the
    // package is there and only its shim is gone.
    //
    // npm clears .bin and rewrites it during a reify, so an install interrupted
    // partway (EBUSY, because this checkout's electron runs as MCP servers)
    // leaves the directory wiped. Checking packages alone reported "everything
    // in place" while nothing could be invoked.
    const binDir = join(nodeModules, '.bin')
    const wantShims = ['vite', 'electron-builder']
    const missingShims = wantShims.filter((name) => (
      !existsSync(join(binDir, name)) && !existsSync(join(binDir, `${name}.cmd`))
    ))
    if (!existsSync(binDir)) {
      fail(
        'node_modules/.bin does not exist, so no package command can be invoked even though the '
        + 'packages themselves are installed. Every build step fails naming the command, not the cause.',
        'npm ci  (or regenerate the shims for packages that declare a bin)',
      )
    } else if (missingShims.length > 0) {
      fail(
        `node_modules/.bin is missing the shim for ${missingShims.join(', ')}. The package is installed; `
        + 'only the command is gone, so the failure arrives as "is not recognized" rather than as a '
        + 'partial install.',
        'npm ci  (or regenerate the shims for packages that declare a bin)',
      )
    } else {
      ok(`node_modules/.bin carries the build command shims (${readdirSync(binDir).length} entries).`)
    }

    // 1d. THE BUILD TOOLCHAIN CAN ACTUALLY RUN.
    //
    // Inventory is not enough, and this is the third time today that was proven.
    // esbuild and rollup ship their compiled work in PLATFORM-SPECIFIC OPTIONAL
    // packages -- @esbuild/win32-x64, @rollup/rollup-win32-x64-msvc -- which are
    // transitive, so they appear in NO declared list this file can read. The two
    // checks above both passed while `npm run build` died inside esbuild saying
    // its binary was missing.
    //
    // So this stops asking what is installed and asks whether the thing works:
    // transform one line, and load rollup's binding. A behavioural check catches
    // every variant of a half-installed toolchain at once, including the ones
    // nobody has met yet.
    const toolchain = [
      { name: 'esbuild', run: async () => (await import('esbuild')).transformSync('const a = 1') },
      { name: 'rollup', run: async () => import('rollup') },
    ]
    for (const tool of toolchain) {
      try {
        await tool.run()
        ok(`${tool.name} runs.`)
      } catch (error) {
        fail(
          `${tool.name} is installed but cannot run (${error.code || error.message}). Its compiled work `
          + 'lives in a platform-specific optional package that no declared list names, so every check '
          + 'above passes while the build fails inside the tool itself.',
          'npm ci  (or fetch the platform package into a scratch prefix and copy it in)',
        )
      }
    }
  }
}

// 2. The explicitly configured engine root resolves, and the report says
//    WHICH declaration selected it. Three suites read the engine as a fixture
//    source. Guessing historical sibling/Desktop layouts made those suites run
//    against whichever old checkout happened to exist first; no marker file
//    can prove that was the owner-selected release input.
let discovery = null
try {
  discovery = discoverCanonicalRoot()
} catch (error) {
  // A malformed declaration is a finding to report, not a reason to stop
  // before the remaining checks run.
  fail(
    `the engine root declaration could not be read: ${error.message}.`,
    'correct private/capability-source.owner.json, or remove it if this clone does not have the private engine',
  )
}
if (discovery && discovery.source !== 'unconfigured' && !discovery.found) {
  fail(
    `${discovery.source} selects ${discovery.root}, which does not hold ${ENGINE_MARKER}; integration fixtures will not search for a different checkout.`,
    'correct the explicit source declaration, or remove it if this clone does not have the private engine',
  )
} else if (discovery?.found) {
  ok(`configured engine root: ${discovery.root} (via ${discovery.source}).`)
} else if (discovery) {
  warn(
    'no private engine checkout is configured; integration fixtures will not inspect sibling or Desktop paths. Set MC_CANONICAL_ROOT, TOOLSENABLED_SOURCE, or private/capability-source.owner.json to run them.',
  )
}

// 3. The release staging root exists and is writable. The old default was a
//    bare Desktop child the reorg emptied, so a plain cut silently recreated
//    a stray folder; the corrected default is pinned by test.
if (!existsSync(DEFAULT_STAGING_ROOT)) {
  fail(
    `release staging root ${DEFAULT_STAGING_ROOT} does not exist; a cut would recreate it somewhere you did not intend.`,
    `mkdir "${DEFAULT_STAGING_ROOT}"`,
  )
} else {
  try {
    const probe = join(DEFAULT_STAGING_ROOT, `.doctor-probe-${process.pid}`)
    writeFileSync(probe, 'probe')
    rmSync(probe)
    ok(`release staging root is writable: ${DEFAULT_STAGING_ROOT}.`)
  } catch {
    fail(
      `release staging root ${DEFAULT_STAGING_ROOT} exists but is not writable.`,
      'check permissions on the folder',
    )
  }
}

// 4. The pinned payload source exists at its recorded ref. The payload the
//    installer ships is cut from this snapshot; if it is gone the build input
//    is gone, and if its HEAD drifted from the recorded pin the next cut
//    ships bytes nobody adopted.
const pinFile = join(REPO, 'private', 'capability-source.owner.json')
if (!existsSync(pinFile)) {
  warn('private/capability-source.owner.json is absent; pack:capability is unavailable on this machine (expected on a contributor clone).')
} else {
  let pin
  try {
    pin = JSON.parse(readFileSync(pinFile, 'utf8'))
  } catch {
    fail('private/capability-source.owner.json is not valid JSON.', 'restore it from the last good commit')
  }
  if (pin && !pin.path) {
    fail(
      'private/capability-source.owner.json does not name a payload source path; the build input cannot be checked.',
      'restore it from the last good commit',
    )
  } else if (pin?.path) {
    if (!existsSync(pin.path)) {
      fail(
        `pinned payload source ${pin.path} does not exist -- the build input for every cut is missing.`,
        'restore the worktree (git -C <engine> worktree add <path> <ref>) or repoint the pin file',
      )
    } else {
      const recordedRef = pin.$comment?.match(/\b[0-9a-f]{7,40}\b/)?.[0]
      const head = spawnSync('git', ['-C', pin.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
      if (head.status !== 0) {
        warn(`pinned payload source exists at ${pin.path} but git could not read its HEAD; ref check skipped.`)
      } else if (recordedRef && !head.stdout.trim().startsWith(recordedRef)) {
        fail(
          `pinned payload source is at ${head.stdout.trim().slice(0, 12)} but the pin records ${recordedRef} -- the snapshot drifted from the adopted ref.`,
          `git -C "${pin.path}" checkout ${recordedRef}  (or update the pin deliberately, flipping capability-manifest.json with it)`,
        )
      } else {
        ok(`pinned payload source: ${pin.path} at ${head.stdout.trim().slice(0, 12)}${recordedRef ? ` (matches recorded ${recordedRef})` : ''}.`)
      }
    }
  }
}

// 5. Production dependencies are installed at the version the lockfile pins.
//    MEASURED 2026-08-27, AND IT WAS A REAL NOTICE VIOLATION RATHER THAN
//    BOOKKEEPING. The lockfile pinned @fontsource-variable/jetbrains-mono at
//    5.3.0, THIRD-PARTY-LICENSES.md reproduced 5.3.0's LICENSE, and
//    node_modules held 5.2.5 -- whose LICENSE text is DIFFERENT. So the build
//    shipped one font and reproduced another font's notice.
//
//    IT GETS THERE BY A ROUTE THAT LOOKS SAFE. A full reify fails EBUSY while
//    this checkout's electron runs (see tools/refuse-install-while-electron-
//    runs.mjs), so packages get added by fetching a tarball and copying the
//    directory in. That path resolves the range in package.json and never reads
//    package-lock.json, so it can install a version the lock does not pin and
//    nothing complains.
//
//    The license gate does catch it -- at the end of a twenty-minute dist,
//    reported as a missing section, which reads like a missing package rather
//    than a version drift. This says it in seconds, in the words of the actual
//    problem.
const lockFile = join(REPO, 'package-lock.json')
if (!existsSync(lockFile)) {
  warn('package-lock.json is absent, so installed versions cannot be checked against a pin. This is not a report that they agree.')
} else {
  let lock = null
  try {
    lock = JSON.parse(readFileSync(lockFile, 'utf8'))
  } catch {
    warn('package-lock.json could not be parsed, so installed versions were not checked. This is not a report that they agree.')
  }
  let manifest = null
  try {
    manifest = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))
  } catch {
    warn('package.json could not be parsed, so installed versions were not checked. This is not a report that they agree.')
  }
  if (lock?.packages && manifest?.dependencies) {
    const drifted = []
    let unreadable = 0
    let checked = 0
    for (const name of Object.keys(manifest.dependencies)) {
      const pinned = lock.packages[`node_modules/${name}`]?.version
      if (!pinned) continue
      const installedManifest = join(REPO, 'node_modules', name, 'package.json')
      if (!existsSync(installedManifest)) continue
      let installed = null
      try {
        installed = JSON.parse(readFileSync(installedManifest, 'utf8')).version
      } catch {
        unreadable += 1
        continue
      }
      checked += 1
      if (installed !== pinned) drifted.push(`${name} installed ${installed}, lockfile pins ${pinned}`)
    }
    // 5b. EVERY package the lockfile pins is actually on disk -- including the
    //     dev tree, because that is what BUILDS the product. Measured 2026-08-27:
    //     sixteen locked packages were absent (cliui, @types/estree, ansi-regex,
    //     eight nested under app-builder-lib, four tslib copies), left behind by
    //     the interrupted EBUSY reifies this repository has recorded before. The
    //     tests never noticed, because none of them import these; the cut died at
    //     electron-builder with "Cannot find module 'cliui'" thrown from inside
    //     yargs, which names a package nobody here depends on directly and reads
    //     like a broken dependency rather than an incomplete install.
    //
    //     Optional packages are skipped deliberately: npm omits them by platform,
    //     so their absence is expected rather than damage.
    const absent = []
    for (const [key, meta] of Object.entries(lock.packages)) {
      if (!key.startsWith('node_modules/') || meta.optional) continue
      if (!existsSync(join(REPO, key, 'package.json'))) absent.push(key.replace('node_modules/', ''))
    }
    if (absent.length > 0) {
      const shown = absent.slice(0, 8).join(', ')
      fail(
        `${absent.length} package(s) the lockfile pins are absent from node_modules: ${shown}`
          + `${absent.length > 8 ? `, and ${absent.length - 8} more` : ''}. `
          + 'The test suite does not import most of these, so it stays green while the BUILD cannot run.',
        'fetch each at its locked version and copy it into place, or run a full install when nothing is holding node_modules',
      )
    } else {
      ok('every package package-lock.json pins is present in node_modules.')
    }

    if (unreadable > 0) {
      warn(`${unreadable} installed production package manifest(s) could not be read, so those versions are UNKNOWN rather than agreeing.`)
    }
    if (drifted.length > 0) {
      fail(
        `${drifted.length} production dependenc${drifted.length === 1 ? 'y is' : 'ies are'} installed at a version the lockfile does not pin: ${drifted.join('; ')}. `
          + 'THIRD-PARTY-LICENSES.md reproduces the LICENSE of whatever is INSTALLED, so a drifted version can ship one license text while the notice carries another.',
        'fetch the pinned version and replace that one package directory, or run a full install when nothing is holding node_modules',
      )
    } else if (checked > 0) {
      ok(`all ${checked} installed production dependenc${checked === 1 ? 'y matches' : 'ies match'} the version package-lock.json pins.`)
    }
  }
}

console.log('Environment doctor:')
for (const line of lines) console.log(line)
console.log(
  failures === 0
    ? 'Everything this checkout needs is in place.'
    : `${failures} problem${failures === 1 ? '' : 's'} need${failures === 1 ? 's' : ''} fixing before this checkout can be trusted.`,
)
process.exitCode = failures
